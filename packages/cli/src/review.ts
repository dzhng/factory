import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

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
  storedReviewFindingsMeetThreshold,
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
  ReviewAttemptCoordinator,
  dockerReviewerExecutor,
  openVerifiedReviewBundle,
  reviewerAdapter,
  resolveReviewerAuthentication,
  selectReviewer,
  unavailableReviewerExecutor,
  type ReviewerDefaults,
} from '@factory/reviewer'

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
  const pullRequest = pullRequestText === undefined ? undefined : pullRequestNumber(pullRequestText)
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
  reviewerAdapter({ provider: 'codex', ...reviewerDefaults.codex })
  reviewerAdapter({ provider: 'claude', ...reviewerDefaults.claude })
  const coordinator = await ReviewAttemptCoordinator.open({ repositoryRoot })
  const subjectLock = reviewSubjectLock(
    coordinator.runtimeRoot,
    store.manifest.repositoryId,
    options.pullRequest,
  )
  return await withAdvisoryFileLock(subjectLock, 24 * 60 * 60 * 1_000, async () => {
    const repositorySettings = await store.readConfig()
    if (repositorySettings.reviewer !== undefined && repositorySettings.reviewer !== 'auto') {
      const configured = repositorySettings.reviewer
      reviewerAdapter({
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
    if ((await recoverDecisionObservations(store, stored)) > 0) stored = await store.readRecords()
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
          return storedReviewFindingsMeetThreshold(prior, options.failOn) ? 1 : 0
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
      const raw = await coordinator.run(
        bundle,
        selected.choice,
        selected.kind === 'selected' ? dockerReviewerExecutor : unavailableReviewerExecutor(),
        {
          imageDigest,
          auth: mount === undefined ? [] : [mount],
          timeoutMs: 10 * 60 * 1000,
          ...(retryGeneration === undefined ? {} : { retryGeneration }),
        },
      )
      const accepted = await acceptReview(await validateReview(bundle, raw), store)
      await coordinator.finalize(bundle, selected.choice, imageDigest, accepted, retryGeneration)
      const currentRecords = await store.readRecords()
      const acceptedReview = loadStoredReviews(currentRecords.records).find(
        review => review.manifest.reviewId === accepted.reviewId && review.lineage === lineage,
      )
      if (acceptedReview === undefined) throw new Error('accepted review manifest is absent')
      const enforced = storedReviewFindingsMeetThreshold(acceptedReview, options.failOn)
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
