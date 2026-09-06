import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveConfiguration } from '@factory/capture'
import { canonicalJson, type RecordId } from '@factory/contract'
import { foldStoredDecisions, loadStoredReviews } from '@factory/domain'
import {
  openRepositoryStore,
  withAdvisoryFileLock,
  type RepositoryRecords,
} from '@factory/repository'
import {
  acceptPartialCoverageByReviewId,
  acceptReview,
  recoverDecisionObservations,
  storedReviewHasVerdict,
  storedReviewResult,
  subjectPathLineage,
  validateReview,
} from '@factory/review'
import {
  bindReviewPolicies,
  buildBundle,
  associateReviewSession,
  loadReviewHistory,
  loadReviewInputs,
  openReviewRepositoryReader,
  observeReviewSubject,
  planReview,
  reviewAuthoringProvider,
} from '@factory/review-plan'
import {
  REVIEW_PROMPT_VERSION,
  DEFAULT_REVIEWER_IMAGE_REFERENCE,
  ReviewAttemptCoordinator,
  dockerReviewerExecutor,
  openVerifiedReviewBundle,
  validateReviewerSettings,
  reviewerImageIdentity,
  resolveReviewerAuthentication,
  selectReviewer,
  unavailableReviewerExecutor,
  type ReviewerDefaults,
} from '@factory/reviewer'
import { openRuntimeJournal } from '@factory/runtime-journal'

import { automaticReviewLockPath } from './automatic-review'
import { dockerLimitFlags, dockerLimitsFromArgs, globalConfig } from './configuration'
import { atomicPrivateWrite, readBoundedOrdinaryFile } from './private-files'

type ReviewOutput = { stdout(value: string): void; stderr(value: string): void }

function pullRequestNumber(value: string): number {
  const number = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number) || number < 1)
    throw new TypeError('--pr must be a positive safe integer')
  return number
}

function reviewSubjectLock(
  runtimeRoot: string,
  repositoryId: string,
  pullRequest: number | undefined,
): string {
  return join(
    runtimeRoot,
    `subject-${createHash('sha256')
      .update(canonicalJson({ repositoryId, pullRequest: pullRequest ?? null }))
      .digest('hex')}.lock`,
  )
}

export async function associateCommand(
  repositoryRoot: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  output: ReviewOutput,
): Promise<number> {
  const expected = new Set(['--pr', '--session', '--actor', '--reason'])
  const values = new Map<string, string>()
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (flag === undefined || !expected.has(flag))
      throw new TypeError(`unknown factory associate option: ${flag ?? ''}`)
    if (values.has(flag)) throw new TypeError(`factory associate option repeated: ${flag}`)
    if (value === undefined || value.startsWith('--'))
      throw new TypeError(`${flag} requires a value`)
    values.set(flag, value)
  }
  for (const flag of expected)
    if (!values.has(flag)) throw new TypeError(`factory associate requires ${flag}`)
  const pullRequestText = values.get('--pr')!
  const sessionKey = values.get('--session')!
  const actor = values.get('--actor')!
  const reason = values.get('--reason')!
  const pullRequest = pullRequestNumber(pullRequestText)
  for (const [flag, value, maximumBytes] of [
    ['--session', sessionKey, 1024],
    ['--actor', actor, 1024],
    ['--reason', reason, 16 * 1024],
  ] as const) {
    if (!value.trim() || Buffer.byteLength(value) > maximumBytes)
      throw new TypeError(`${flag} must be nonblank and bounded`)
  }
  const store = await openRepositoryStore(repositoryRoot)
  const coordinator = await ReviewAttemptCoordinator.open({ repositoryRoot })
  const result = await withAdvisoryFileLock(
    reviewSubjectLock(coordinator.runtimeRoot, store.manifest.repositoryId, pullRequest),
    24 * 60 * 60 * 1_000,
    async () =>
      await associateReviewSession(
        repositoryRoot,
        store,
        pullRequest,
        { sessionKey, actor, reason },
        environment,
      ),
  )
  output.stdout(canonicalJson({ schemaVersion: 1, status: 'associated', ...result }))
  return 0
}

function decisionView(records: RepositoryRecords, canonicalBranch?: string) {
  return canonicalBranch === undefined ? null : foldStoredDecisions(records, canonicalBranch)
}

const FACTORY_REVIEWER_DEFAULTS = {
  codex: { model: 'gpt-5.6-sol', effort: 'xhigh' },
  claude: { model: 'claude-opus-5', effort: 'high' },
} as const

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

type ReviewCliOptions = {
  mode: 'incremental' | 'full' | 'force'
  automatic: boolean
  pullRequest?: number
  sessionKey?: string
  failOn?: 'unsound' | 'needs-user'
  acceptPartial?: RecordId
}

function parseReviewOptions(args: readonly string[]): ReviewCliOptions {
  const valueFlags = new Set([
    '--pr',
    '--session',
    '--fail-on',
    '--accept-partial',
    ...Object.keys(dockerLimitFlags),
  ])
  const booleanFlags = new Set(['--full', '--force', '--automatic'])
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
  if (seen.has('--automatic') && seen.size !== 1)
    throw new TypeError('--automatic cannot be combined with review execution options')
  const pullRequestText = values.get('--pr')
  const pullRequest = pullRequestText === undefined ? undefined : pullRequestNumber(pullRequestText)
  const sessionKey = values.get('--session')
  if (sessionKey !== undefined && (!sessionKey.trim() || Buffer.byteLength(sessionKey) > 1024))
    throw new TypeError('--session must be nonblank and bounded')
  const failOn = values.get('--fail-on')
  if (failOn !== undefined && !['unsound', 'needs-user'].includes(failOn))
    throw new TypeError('--fail-on must be unsound or needs-user')
  const acceptPartial = values.get('--accept-partial')
  if (acceptPartial !== undefined && !/^review_[0-9A-HJKMNP-TV-Z]{26}$/.test(acceptPartial))
    throw new TypeError('--accept-partial must name a review ID')
  if (acceptPartial !== undefined && seen.size !== 1)
    throw new TypeError('--accept-partial cannot be combined with review execution options')
  return {
    automatic: seen.has('--automatic'),
    mode: seen.has('--force') ? 'force' : seen.has('--full') ? 'full' : 'incremental',
    ...(pullRequest === undefined ? {} : { pullRequest }),
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
  const store = await openRepositoryStore(repositoryRoot)
  if (options.acceptPartial !== undefined) {
    const path = await acceptPartialCoverageByReviewId(store, options.acceptPartial)
    output.stdout(canonicalJson({ schemaVersion: 1, status: 'accepted-partial', path }))
    return 0
  }
  const reviewerDefaults = requiredReviewDefaults(environment)
  validateReviewerSettings({ provider: 'codex', ...reviewerDefaults.codex })
  validateReviewerSettings({ provider: 'claude', ...reviewerDefaults.claude })
  const coordinator = await ReviewAttemptCoordinator.open({ repositoryRoot })
  const subjectLock = reviewSubjectLock(
    coordinator.runtimeRoot,
    store.manifest.repositoryId,
    options.pullRequest,
  )
  return await withAdvisoryFileLock(subjectLock, 24 * 60 * 60 * 1_000, async () => {
    const repositorySettings = await store.readConfig()
    const settings = resolveConfiguration(
      { dockerLimits: dockerLimitsFromArgs(args) },
      repositorySettings,
      await globalConfig(environment),
    )
    if (
      options.automatic &&
      (!settings.automaticReview ||
        pendingAutomaticTriggers(await store.readRecords()).length === 0)
    ) {
      output.stdout(canonicalJson({ schemaVersion: 1, status: 'no-pending-automatic-review' }))
      return 0
    }
    if (settings.reviewer !== 'auto') {
      const configured = settings.reviewer
      validateReviewerSettings({
        provider: configured.provider,
        model: configured.model ?? reviewerDefaults[configured.provider].model,
        effort: configured.effort ?? reviewerDefaults[configured.provider].effort,
      })
    }
    const subjectPath = await observeReviewSubject(
      repositoryRoot,
      store,
      options.pullRequest,
      environment,
    )
    let stored = await store.readRecords()
    if ((await recoverDecisionObservations(store)) > 0) stored = await store.readRecords()
    const committedReviews = loadStoredReviews(stored.records)
    const lineage = subjectPathLineage(subjectPath, stored.records)
    const retryGeneration = committedReviews
      .filter(
        review =>
          review.lineage === lineage &&
          (review.manifest.disposition === 'failed' ||
            review.manifest.limitations.some(item => item.code === 'invalid-review-output')),
      )
      .map(review => review.manifest.reviewId)
      .sort()
      .at(-1)
    await coordinator.reconcileAccepted(committedReviews.map(review => review.manifest))
    const reader = await openReviewRepositoryReader(store.factoryRoot)
    const history = await loadReviewHistory(reader)
    const evidence = await loadReviewInputs(reader, {
      mode: options.mode,
      subjectPath,
      history,
      reviewLimits: repositorySettings.reviewLimits,
      ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
    })
    const authoringProvider = reviewAuthoringProvider(evidence)
    const auth = await resolveReviewerAuthentication(environment)
    const selected = selectReviewer(
      settings.reviewer,
      authoringProvider,
      auth.availability,
      reviewerDefaults,
    )
    const policies = {
      reviewer: selected.choice.settings,
      analyzerVersion: 'factory-choice-audit-v1',
      promptVersion: REVIEW_PROMPT_VERSION,
      policyVersion: 'factory-review-policy-v1',
      formatVersion: 1 as const,
    }
    const plan = planReview(bindReviewPolicies(evidence, policies))
    if (plan.status !== 'ready') {
      if (plan.status === 'already-reviewed') {
        const prior = committedReviews.find(
          review => review.paths.ledger === plan.priorLedger?.path,
        )
        if (prior !== undefined) {
          const currentSettings = await store.readConfig()
          output.stdout(
            canonicalJson({
              ...storedReviewResult(prior, 'already-reviewed'),
              decisions: decisionView(stored, currentSettings.canonicalBranch),
            }),
          )
          return storedReviewHasVerdict(prior, options.failOn) ? 1 : 0
        }
      }
      output.stdout(
        canonicalJson({ schemaVersion: 1, status: plan.status, limitations: plan.limitations }),
      )
      return plan.status === 'unavailable' ? 1 : 0
    }
    const imageReference = environment.FACTORY_REVIEWER_IMAGE ?? DEFAULT_REVIEWER_IMAGE_REFERENCE
    const imageDigest = reviewerImageIdentity(imageReference).digest
    const bundleParent = await mkdtemp(join(coordinator.runtimeRoot, 'review-bundle-'))
    try {
      const built = await buildBundle(
        plan,
        store,
        join(bundleParent, 'bundle'),
        store.manifest.repositoryId,
      )
      const bundle = await openVerifiedReviewBundle(built.path, built.sha256)
      const credential = auth.sources[selected.choice.settings.provider]
      const raw = await coordinator.run(
        bundle,
        selected.choice,
        selected.kind === 'selected' ? dockerReviewerExecutor : unavailableReviewerExecutor(),
        {
          imageReference,
          imageDigest,
          ...(credential === undefined ? {} : { credential }),
          timeoutMs: settings.dockerLimits.timeoutSeconds * 1000,
          dockerLimits: settings.dockerLimits,
          ...(retryGeneration === undefined ? {} : { retryGeneration }),
        },
      )
      const accepted = await acceptReview(
        await validateReview(bundle, raw, {
          store,
          coordinator,
          ...(retryGeneration === undefined ? {} : { retryGeneration }),
        }),
        store,
      )
      await coordinator.finalize(bundle, selected.choice, imageDigest, accepted, retryGeneration)
      const currentRecords = await store.readRecords()
      const acceptedReview = loadStoredReviews(currentRecords.records).find(
        review => review.manifest.reviewId === accepted.reviewId && review.lineage === lineage,
      )
      if (acceptedReview === undefined) throw new Error('accepted review manifest is absent')
      const enforced = storedReviewHasVerdict(acceptedReview, options.failOn)
      const currentSettings = await store.readConfig()
      output.stdout(
        canonicalJson({
          ...storedReviewResult(acceptedReview),
          decisions: decisionView(currentRecords, currentSettings.canonicalBranch),
        }),
      )
      return accepted.executionFailed || enforced ? 1 : 0
    } finally {
      await rm(bundleParent, { recursive: true, force: true })
    }
  })
}

function pendingAutomaticTriggers(records: RepositoryRecords): string[] {
  const attempted = new Set(
    loadStoredReviews(records.records)
      .filter(review => review.manifest.subject.kind === 'workspace')
      .flatMap(review => review.manifest.triggerIds),
  )
  return records.records
    .filter(record => /^review-triggers\/[^/]+\.json$/.test(record.path))
    .map(record => record.path.slice('review-triggers/'.length, -'.json'.length))
    .filter(id => !attempted.has(id as RecordId))
    .sort()
}

/** Drain new durable triggers; failed or unchanged work never creates a retry loop. */
export async function automaticReviewCommand(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  output: ReviewOutput,
): Promise<number> {
  try {
    const store = await openRepositoryStore(repositoryRoot)
    const lockPath = await automaticReviewLockPath(repositoryRoot)
    const attemptPath = `${lockPath}.attempt`
    let observed: string[] = []
    while (true) {
      const code = await withAdvisoryFileLock<number | undefined>(
        lockPath,
        0,
        async () => {
          let pending = pendingAutomaticTriggers(await store.readRecords())
          observed = pending
          while (pending.length > 0) {
            const settings = resolveConfiguration(
              {},
              await store.readConfig(),
              await globalConfig(environment),
            )
            if (!settings.automaticReview) return 0
            const fingerprint = createHash('sha256').update(canonicalJson(pending)).digest('hex')
            const previous = await readBoundedOrdinaryFile(attemptPath, 64)
            if (previous !== undefined && new TextDecoder().decode(previous) === fingerprint)
              return 0
            let code: number
            try {
              code = await reviewCommand(
                repositoryRoot,
                ['review', '--automatic'],
                environment,
                output,
              )
            } catch (error) {
              await recordAutomaticFailure(repositoryRoot, error)
              code = 1
            }
            const current = resolveConfiguration(
              {},
              await store.readConfig(),
              await globalConfig(environment),
            )
            if (current.automaticReview)
              await atomicPrivateWrite(attemptPath, new TextEncoder().encode(fingerprint))
            if (code !== 0) {
              await recordAutomaticFailure(
                repositoryRoot,
                new Error('automatic review failed; run factory review for details'),
              )
              return code
            }
            const next = pendingAutomaticTriggers(await store.readRecords())
            if (!pending.some(id => !next.includes(id))) return 0
            observed = next
            pending = next
          }
          return 0
        },
        () => undefined,
      )
      if (code === undefined) return 0
      // A contending wake can exit between the final read and unlock. Re-read
      // after releasing ownership so either this worker or the new wake sees it.
      const next = pendingAutomaticTriggers(await store.readRecords())
      if (!next.some(id => !observed.includes(id))) return code
    }
  } catch (error) {
    await recordAutomaticFailure(repositoryRoot, error)
    return 1
  }
}

async function recordAutomaticFailure(repositoryRoot: string, error: unknown): Promise<void> {
  const journal = await openRuntimeJournal({ repositoryRoot })
  try {
    await journal.recordDiagnostic(error)
  } finally {
    await journal.close()
  }
}
