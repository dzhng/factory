import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import {
  canonicalJson,
  newRecordId,
  parseRepositoryConfig,
  type AssociationBatch,
  type AvailablePullRequestObservation,
  type GithubRepositoryMappingObservation,
  type OwnedPath,
  type RecordId,
  type RepositoryConfig,
  type ReviewLedger,
  type ReviewManifest,
  type SessionPullRequestAssociation,
} from '@factory/contract'
import { deriveAssociations } from '@factory/domain'
import {
  GithubPrObserver,
  observeGithubRepositoryMapping,
  persistGithubRepositoryMapping,
  persistPullRequestEvidence,
  verifyAssociationBatch,
} from '@factory/github'
import {
  GitObserver,
  openRepositoryStore,
  withAdvisoryFileLock,
  type RepositoryStore,
} from '@factory/repository'
import { acceptPartialCoverageByReviewId, acceptReview, validateReview } from '@factory/review'
import {
  bindReviewPolicies,
  buildBundle,
  loadCandidateEvidence,
  loadReviewHistory,
  loadReviewInputs,
  openReviewRepositoryReader,
  planReview,
  reviewAuthoringProvider,
} from '@factory/review-plan'
import {
  REVIEW_PROMPT_VERSION,
  ReviewAttemptAlreadyFinalizedError,
  ReviewAttemptCoordinator,
  dockerReviewerExecutor,
  openVerifiedReviewBundle,
  reviewerAdapter,
  selectReviewer,
  unavailableReviewerExecutor,
  type ReadonlyAuthMount,
  type ReviewerAvailability,
  type ReviewerDefaults,
} from '@factory/reviewer'

export type ReviewOutput = { stdout(value: string): void; stderr(value: string): void }

const textEncoder = new TextEncoder()
const FACTORY_REVIEWER_DEFAULTS = {
  codex: { model: 'gpt-5.6-sol', effort: 'xhigh' },
  claude: { model: 'claude-opus-5', effort: 'high' },
} as const

async function repositoryConfig(repositoryRoot: string): Promise<RepositoryConfig> {
  return parseRepositoryConfig(
    JSON.parse(await readFile(join(repositoryRoot, '.factory', 'config.json'), 'utf8')),
  )
}

function requiredReviewDefaults(environment: NodeJS.ProcessEnv): ReviewerDefaults {
  const values = {
    codex: {
      model: environment.FACTORY_CODEX_REVIEW_MODEL ?? FACTORY_REVIEWER_DEFAULTS.codex.model,
      effort: environment.FACTORY_CODEX_REVIEW_EFFORT ?? FACTORY_REVIEWER_DEFAULTS.codex.effort,
    },
    claude: {
      model: environment.FACTORY_CLAUDE_REVIEW_MODEL ?? FACTORY_REVIEWER_DEFAULTS.claude.model,
      effort: environment.FACTORY_CLAUDE_REVIEW_EFFORT ?? FACTORY_REVIEWER_DEFAULTS.claude.effort,
    },
  }
  for (const [provider, value] of Object.entries(values))
    if (!value.model?.trim() || !value.effort?.trim())
      throw new Error(`Factory reviewer defaults are not configured for ${provider}`)
  return values as ReviewerDefaults
}

async function dedicatedReviewerAuth(environment: NodeJS.ProcessEnv): Promise<{
  availability: ReviewerAvailability
  mounts: Partial<Record<'codex' | 'claude', Omit<ReadonlyAuthMount, 'mode'>>>
}> {
  const configured = {
    codex: environment.FACTORY_CODEX_AUTH_FILE,
    claude: environment.FACTORY_CLAUDE_AUTH_FILE,
  }
  const mounts: Partial<Record<'codex' | 'claude', Omit<ReadonlyAuthMount, 'mode'>>> = {}
  const availability: Record<'codex' | 'claude', boolean> = { codex: false, claude: false }
  for (const provider of ['codex', 'claude'] as const) {
    const path = configured[provider]
    if (path === undefined || !isAbsolute(path)) continue
    const metadata = await lstat(path).catch(() => undefined)
    if (
      metadata === undefined ||
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > 1024 * 1024 ||
      metadata.uid === 0 ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o400) === 0
    )
      continue
    const canonicalPath = await realpath(path)
    const canonicalMetadata = await lstat(canonicalPath).catch(() => undefined)
    if (
      canonicalMetadata === undefined ||
      !canonicalMetadata.isFile() ||
      canonicalMetadata.dev !== metadata.dev ||
      canonicalMetadata.ino !== metadata.ino ||
      canonicalMetadata.size !== metadata.size ||
      canonicalMetadata.uid !== metadata.uid ||
      canonicalMetadata.mode !== metadata.mode
    )
      continue
    availability[provider] = true
    mounts[provider] = {
      hostPath: canonicalPath,
      containerPath:
        provider === 'codex' ? '/auth/codex/auth.json' : '/auth/claude/.credentials.json',
      expectedIdentity: {
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        uid: metadata.uid,
        mode: metadata.mode,
      },
    }
  }
  return { availability, mounts }
}

async function freshReviewSubject(
  repositoryRoot: string,
  store: RepositoryStore,
  pullRequest: number | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<OwnedPath> {
  const objects = {
    put: async (bytes: Uint8Array, metadata: { mediaType: string; role: string }) =>
      await store.putObject(
        (async function* () {
          yield bytes
        })(),
        metadata,
      ),
  }
  if (pullRequest === undefined) {
    const observationId = newRecordId('observation')
    const observed = await new GitObserver(
      repositoryRoot,
      { ...objects, get: async reference => await store.getObject(reference) },
      { repositoryId: store.manifest.repositoryId, observationId },
    ).observe()
    if (observed.kind === 'unavailable')
      throw new Error(`workspace observation unavailable: ${observed.reason.code}`)
    const observation = observed.kind === 'raced' ? observed.partial : observed.observation
    const path = `repository-observations/${observation.observationId}.json` as OwnedPath
    await store.createImmutable(path, textEncoder.encode(canonicalJson(observation)))
    return path
  }

  const hostname = (environment.GH_HOST ?? 'github.com').toLowerCase()
  const mapping = await observeGithubRepositoryMapping(store.manifest.repositoryId, hostname, {
    objects,
    cwd: repositoryRoot,
    environment,
  })
  if ('availability' in mapping)
    throw new Error(`pull-request repository mapping unavailable: ${mapping.reason}`)
  await persistGithubRepositoryMapping(store, mapping)
  const [owner, name, ...extra] = mapping.repository.split('/')
  if (!owner || !name || extra.length !== 0)
    throw new Error('pull-request repository mapping returned an invalid name')
  const observation = await new GithubPrObserver({
    objects,
    cwd: repositoryRoot,
    environment,
  }).observe({
    hostname: mapping.hostname,
    owner,
    name,
    number: pullRequest,
  })
  if (observation.availability === 'unavailable') {
    if (observation.record !== undefined)
      await persistPullRequestEvidence(store, observation.record, [])
    throw new Error(`pull-request observation unavailable: ${observation.reason}`)
  }
  const records = (await store.readRecords()).records
  const recordByPath = new Map(records.map(record => [record.path, record.value]))
  const reader = await openReviewRepositoryReader(store.factoryRoot)
  const triggerRecords = records.filter(record =>
    /^review-triggers\/[^/]+\.json$/.test(record.path),
  )
  if (triggerRecords.length > 10_000)
    throw new Error('pull-request association trigger inventory exceeds its bound')
  const candidates = new Array<Awaited<ReturnType<typeof loadCandidateEvidence>>>()
  for (let offset = 0; offset < triggerRecords.length; offset += 8) {
    candidates.push(
      ...(await Promise.all(
        triggerRecords.slice(offset, offset + 8).map(async record => {
          const triggerId = record.path.slice(
            'review-triggers/'.length,
            -'.json'.length,
          ) as RecordId
          return await loadCandidateEvidence(reader, {
            triggerId,
            scopeProof: { kind: 'workspace-store', repositoryId: store.manifest.repositoryId },
          })
        }),
      )),
    )
  }
  const sessions = candidates.flatMap(candidate => {
    if (
      !('trigger' in candidate) ||
      candidate.repositoryObservation === undefined ||
      candidate.identity.repositoryId !== store.manifest.repositoryId
    )
      return []
    return [
      {
        provider: candidate.trigger.provider,
        turn: candidate.turn,
        repositoryObservation: candidate.repositoryObservation,
      },
    ]
  })
  const repositoryMappings = records
    .filter(record => record.path.includes('/repository-mappings/'))
    .map(record => record.value as unknown as GithubRepositoryMappingObservation)
  const priorPullRequests = new Map(
    records
      .filter(
        record =>
          new RegExp(
            `^pull-requests/github/${observation.repositoryKey}/${observation.number}/observations/[^/]+\\.json$`,
          ).test(record.path) &&
          (record.value as { availability?: string }).availability === 'available' &&
          (record.value as { observationId?: string }).observationId !== observation.observationId,
      )
      .map(record => {
        const value = record.value as unknown as AvailablePullRequestObservation
        return [value.observationId, value] as const
      }),
  )
  const associationRoot = `pull-requests/github/${observation.repositoryKey}/${observation.number}/associations/`
  const previous = records
    .filter(
      record =>
        record.path.startsWith(associationRoot) && /\/batches\/[^/]+\.json$/.test(record.path),
    )
    .flatMap(record => {
      const batch = record.value as unknown as AssociationBatch
      const pullRequest = priorPullRequests.get(batch.pullRequestObservationId)
      if (pullRequest === undefined) return []
      const root = `${associationRoot}${batch.pullRequestObservationId}`
      const evidence = batch.evidence.flatMap(reference => {
        const value = recordByPath.get(`${root}/${reference.evidenceId}.json` as OwnedPath)
        return value === undefined ? [] : [value as unknown as SessionPullRequestAssociation]
      })
      if (!verifyAssociationBatch(batch, pullRequest, evidence)) return []
      return evidence.map(association => ({ pullRequest, association }))
    })
  const associations = deriveAssociations({
    pullRequest: observation,
    sessions,
    repositoryMappings,
    previous,
  })
  await persistPullRequestEvidence(store, observation, associations)
  return `pull-requests/github/${observation.repositoryKey}/${observation.number}/observations/${observation.observationId}.json` as OwnedPath
}

function committedReviewManifests(
  records: Awaited<ReturnType<RepositoryStore['readRecords']>>['records'],
): ReviewManifest[] {
  return records
    .filter(record => /^reviews\/.*\/manifest\.json$/.test(record.path))
    .map(record => {
      const review = record.value as unknown as ReviewManifest
      const root = dirname(record.path)
      const siblings = records
        .filter(candidate => dirname(candidate.path) === root)
        .map(candidate => candidate.path)
        .sort()
      const expected = [record.path, `${root}/response.txt`]
      if (review.disposition !== 'failed') expected.push(`${root}/ledger.json`)
      if (canonicalJson(siblings) !== canonicalJson(expected.sort()))
        throw new Error('stored review does not have an exact committed record group')
      return review
    })
}

function reviewResultOutput(review: ReviewManifest, status?: 'already-reviewed'): string {
  const root =
    review.subject.kind === 'workspace'
      ? `reviews/workspace/${review.reviewId}`
      : `reviews/pull-requests/github/${review.subject.repositoryKey}/${review.subject.number}/${review.reviewId}`
  return canonicalJson({
    schemaVersion: 1,
    ...(status === undefined ? {} : { status }),
    reviewId: review.reviewId,
    disposition: review.disposition,
    limitations: review.limitations,
    reviewer: { ...review.reviewer, version: review.providerCliVersion },
    coverageEffect: review.subjectAttempt.effect,
    paths: {
      manifest: `${root}/manifest.json`,
      response: `${root}/response.txt`,
      ...(review.disposition === 'failed' ? {} : { ledger: `${root}/ledger.json` }),
    },
    executionFailed:
      review.disposition === 'failed' ||
      review.limitations.some(item => item.code === 'invalid-review-output'),
  })
}

function reviewSubjectLineage(
  review: ReviewManifest,
  records: Awaited<ReturnType<RepositoryStore['readRecords']>>['records'],
): string {
  if (review.subject.kind === 'pull-request')
    return canonicalJson({
      kind: review.subject.kind,
      repositoryKey: review.subject.repositoryKey,
      number: review.subject.number,
    })
  const observationId = review.subject.repositoryObservationId
  const observation = records.find(
    record => record.path === `repository-observations/${observationId}.json`,
  )?.value
  if (
    typeof observation !== 'object' ||
    observation === null ||
    Array.isArray(observation) ||
    typeof observation.repositoryId !== 'string'
  )
    throw new Error('stored workspace review does not resolve to its subject lineage')
  return canonicalJson({ kind: review.subject.kind, repositoryId: observation.repositoryId })
}

function subjectPathLineage(
  path: OwnedPath,
  records: Awaited<ReturnType<RepositoryStore['readRecords']>>['records'],
): string {
  const subject = records.find(record => record.path === path)?.value
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject))
    throw new Error('selected review subject is absent')
  if (path.startsWith('repository-observations/')) {
    if (typeof subject.repositoryId !== 'string')
      throw new Error('selected workspace subject has no repository lineage')
    return canonicalJson({ kind: 'workspace', repositoryId: subject.repositoryId })
  }
  if (typeof subject.repositoryKey !== 'string' || typeof subject.number !== 'number')
    throw new Error('selected pull-request subject has no repository lineage')
  return canonicalJson({
    kind: 'pull-request',
    repositoryKey: subject.repositoryKey,
    number: subject.number,
  })
}

async function reviewFindingsEnforced(
  store: RepositoryStore,
  reviewId: RecordId,
  failOn: ReviewCliOptions['failOn'],
): Promise<boolean> {
  if (failOn === undefined) return false
  const match = (await store.readRecords()).records.find(record =>
    record.path.endsWith(`/${reviewId}/ledger.json`),
  )
  if (match === undefined) return false
  const ledger = match.value as unknown as ReviewLedger
  const ranks = { low: 1, medium: 2, high: 3, critical: 4 } as const
  return ledger.entries.some(
    entry => entry.kind === 'finding' && ranks[entry.severity] >= ranks[failOn],
  )
}

type ReviewCliOptions = {
  mode: 'incremental' | 'full' | 'force'
  pullRequest?: number
  sessionKey?: string
  failOn?: 'low' | 'medium' | 'high' | 'critical'
  acceptPartial?: RecordId
}

function parseReviewOptions(args: readonly string[]): ReviewCliOptions {
  const valueFlags = new Set(['--pr', '--session', '--fail-on', '--accept-partial'])
  const booleanFlags = new Set(['--full', '--force'])
  const seen = new Set<string>()
  const values = new Map<string, string>()
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!
    if (!valueFlags.has(flag) && !booleanFlags.has(flag))
      throw new TypeError(`unknown factory review option: ${flag}`)
    if (seen.has(flag)) throw new TypeError(`factory review option repeated: ${flag}`)
    seen.add(flag)
    if (valueFlags.has(flag)) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--'))
        throw new TypeError(`${flag} requires a value`)
      values.set(flag, value)
      index += 1
    }
  }
  if (seen.has('--full') && seen.has('--force'))
    throw new TypeError('--full and --force are mutually exclusive')
  const pullRequestText = values.get('--pr')
  if (pullRequestText !== undefined && !/^[1-9]\d*$/.test(pullRequestText))
    throw new TypeError('--pr must be a positive integer')
  const sessionKey = values.get('--session')
  if (sessionKey !== undefined && (!sessionKey.trim() || Buffer.byteLength(sessionKey) > 1024))
    throw new TypeError('--session must be nonblank and bounded')
  const failOn = values.get('--fail-on')
  if (failOn !== undefined && !['low', 'medium', 'high', 'critical'].includes(failOn))
    throw new TypeError('--fail-on must be low, medium, high, or critical')
  const acceptPartial = values.get('--accept-partial')
  if (acceptPartial !== undefined && !/^review_[0-9A-HJKMNP-TV-Z]{26}$/.test(acceptPartial))
    throw new TypeError('--accept-partial must name a review ID')
  if (acceptPartial !== undefined && seen.size !== 1)
    throw new TypeError('--accept-partial cannot be combined with review execution options')
  return {
    mode: seen.has('--force') ? 'force' : seen.has('--full') ? 'full' : 'incremental',
    ...(pullRequestText === undefined ? {} : { pullRequest: Number(pullRequestText) }),
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(failOn === undefined ? {} : { failOn: failOn as ReviewCliOptions['failOn'] & string }),
    ...(acceptPartial === undefined ? {} : { acceptPartial: acceptPartial as RecordId }),
  }
}

export async function reviewCommand(
  repositoryRoot: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  output: ReviewOutput,
): Promise<number> {
  const options = parseReviewOptions(args)
  const coordinator = await ReviewAttemptCoordinator.open({ repositoryRoot })
  if (options.acceptPartial !== undefined) {
    const store = await openRepositoryStore(repositoryRoot)
    const path = await acceptPartialCoverageByReviewId(store, options.acceptPartial)
    output.stdout(canonicalJson({ schemaVersion: 1, status: 'accepted-partial', path }))
    return 0
  }
  const store = await openRepositoryStore(repositoryRoot)
  const reviewerDefaults = requiredReviewDefaults(environment)
  reviewerAdapter({ provider: 'codex', ...reviewerDefaults.codex })
  reviewerAdapter({ provider: 'claude', ...reviewerDefaults.claude })
  const repositorySettings = await repositoryConfig(repositoryRoot)
  if (repositorySettings.reviewer !== undefined && repositorySettings.reviewer !== 'auto') {
    const configured = repositorySettings.reviewer
    reviewerAdapter({
      provider: configured.provider,
      model: configured.model ?? reviewerDefaults[configured.provider].model,
      effort: configured.effort ?? reviewerDefaults[configured.provider].effort,
    })
  }
  const subjectLock = join(
    coordinator.runtimeRoot,
    `subject-${createHash('sha256')
      .update(
        canonicalJson({
          repositoryId: store.manifest.repositoryId,
          pullRequest: options.pullRequest ?? null,
        }),
      )
      .digest('hex')}.lock`,
  )
  return await withAdvisoryFileLock(subjectLock, 24 * 60 * 60 * 1_000, async () => {
    const subjectPath = await freshReviewSubject(
      repositoryRoot,
      store,
      options.pullRequest,
      environment,
    )
    const stored = await store.readRecords()
    const committedReviews = committedReviewManifests(stored.records)
    const lineage = subjectPathLineage(subjectPath, stored.records)
    const retryGeneration = committedReviews
      .filter(
        review =>
          reviewSubjectLineage(review, stored.records) === lineage &&
          (review.disposition === 'failed' ||
            review.limitations.some(item => item.code === 'invalid-review-output')),
      )
      .map(review => review.reviewId)
      .sort()
      .at(-1)
    await coordinator.reconcileAccepted(committedReviews)
    const reader = await openReviewRepositoryReader(store.factoryRoot)
    const history = await loadReviewHistory(reader)
    const evidence = await loadReviewInputs(reader, {
      mode: options.mode,
      subjectPath,
      history,
      reviewLimits: (await repositoryConfig(repositoryRoot)).reviewLimits,
      ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
    })
    const authoringProvider = reviewAuthoringProvider(evidence)
    const auth = await dedicatedReviewerAuth(environment)
    const selected = selectReviewer(
      repositorySettings.reviewer ?? 'auto',
      authoringProvider,
      auth.availability,
      reviewerDefaults,
    )
    const policies = {
      reviewer: selected.choice.settings,
      analyzerVersion: 'factory-review-analyzer-v1',
      promptVersion: REVIEW_PROMPT_VERSION,
      policyVersion: 'factory-review-policy-v1',
      formatVersion: 1 as const,
    }
    const plan = planReview(bindReviewPolicies(evidence, policies))
    if (plan.status !== 'ready') {
      if (plan.status === 'already-reviewed') {
        const priorId = plan.priorLedger?.ledger.reviewId
        const prior = committedReviews.find(review => review.reviewId === priorId)
        if (prior !== undefined) {
          output.stdout(reviewResultOutput(prior, 'already-reviewed'))
          return (await reviewFindingsEnforced(store, prior.reviewId, options.failOn)) ? 1 : 0
        }
      }
      output.stdout(
        canonicalJson({ schemaVersion: 1, status: plan.status, limitations: plan.limitations }),
      )
      return plan.status === 'unavailable' ? 1 : 0
    }
    const imageDigest = environment.FACTORY_REVIEWER_IMAGE_DIGEST
    if (!imageDigest || !/^sha256:[0-9a-f]{64}$/.test(imageDigest))
      throw new Error('FACTORY_REVIEWER_IMAGE_DIGEST must pin an immutable reviewer image')
    const bundleParent = await mkdtemp(join(coordinator.runtimeRoot, 'review-bundle-'))
    try {
      const built = await buildBundle(
        plan,
        store,
        join(bundleParent, 'bundle'),
        store.manifest.repositoryId,
      )
      const bundle = await openVerifiedReviewBundle(built.path, built.sha256)
      const mount = auth.mounts[selected.choice.settings.provider]
      let raw
      let executionGeneration = retryGeneration
      for (let advances = 0; ; advances += 1) {
        if (advances > 64) throw new Error('review attempt tombstone chain exceeds its bound')
        try {
          raw = await coordinator.run(
            bundle,
            selected.choice,
            selected.kind === 'selected' ? dockerReviewerExecutor : unavailableReviewerExecutor(),
            {
              imageDigest,
              auth: mount === undefined ? [] : [mount],
              timeoutMs: 10 * 60 * 1000,
              ...(executionGeneration === undefined
                ? {}
                : { retryGeneration: executionGeneration }),
            },
          )
          break
        } catch (error) {
          if (!(error instanceof ReviewAttemptAlreadyFinalizedError)) throw error
          const currentReviews = committedReviewManifests((await store.readRecords()).records)
          if (!currentReviews.some(review => review.reviewId === error.reviewId)) {
            executionGeneration = error.reviewId
            continue
          }
          const enforced = await reviewFindingsEnforced(store, error.reviewId, options.failOn)
          output.stdout(
            reviewResultOutput(
              currentReviews.find(review => review.reviewId === error.reviewId)!,
              'already-reviewed',
            ),
          )
          return error.outcome.executionFailed || enforced ? 1 : 0
        }
      }
      const accepted = await acceptReview(await validateReview(bundle, raw), store)
      await coordinator.finalize(
        bundle,
        selected.choice,
        imageDigest,
        accepted,
        executionGeneration,
      )
      const enforced = await reviewFindingsEnforced(store, accepted.reviewId, options.failOn)
      const acceptedManifest = committedReviewManifests((await store.readRecords()).records).find(
        review => review.reviewId === accepted.reviewId,
      )
      if (acceptedManifest === undefined) throw new Error('accepted review manifest is absent')
      output.stdout(reviewResultOutput(acceptedManifest))
      return accepted.executionFailed || enforced ? 1 : 0
    } finally {
      await rm(bundleParent, { recursive: true, force: true })
    }
  })
}
