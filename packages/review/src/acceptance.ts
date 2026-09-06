import {
  canonicalJson,
  makeOwnedPath,
  type CoverageAction,
  type Limitation,
  type RecordId,
  type ReviewFailureReason,
  type ReviewLedger,
  type ReviewManifest,
  type Sha256,
} from '@factory/contract'
import { readAuditDraft } from '@factory/contract'
import { loadStoredReviews } from '@factory/domain'
import type { RepositoryStore } from '@factory/repository'
import {
  readVerifiedReviewBundle,
  readReviewerRawAttempt,
  type ReviewerRawAttempt,
  type ReviewerRawAttemptSnapshot,
  type VerifiedReviewBundle,
} from '@factory/reviewer'

import { appendDecisionObservations } from './decisions'

export type AttemptTermination = import('@factory/reviewer').ReviewerExecutionTermination
export type RawAttempt = ReviewerRawAttempt

export type AcceptedReview = {
  reviewId: RecordId
  disposition: ReviewManifest['disposition']
  path: ReturnType<typeof makeOwnedPath>
  executionFailed: boolean
}

export type PartialCoverageAcceptance = Omit<
  CoverageAction,
  'schemaVersion' | 'actionId' | 'createdAt'
> & {
  subject: ReviewManifest['subject']
}

declare const validatedAttemptBrand: unique symbol
export type ValidatedAttempt = { readonly [validatedAttemptBrand]: true }

type ValidatedState = {
  manifest: ReviewManifest
  ledger?: ReviewLedger
  submissions: Uint8Array
  executionFailed: boolean
  rootSegments: readonly string[]
  repositoryId?: string
  subjectPath: ReturnType<typeof makeOwnedPath>
  subjectRecord: string
  inventory: readonly import('@factory/contract').ObjectRef[]
  recordObjects: readonly {
    path: ReturnType<typeof makeOwnedPath>
    object: import('@factory/contract').ObjectRef
  }[]
  records: readonly { path: ReturnType<typeof makeOwnedPath>; sha256: string }[]
}

const validatedAttempts = new WeakMap<object, ValidatedState>()

function failureReason(
  attempt: ReviewerRawAttemptSnapshot,
  hasEntries: boolean,
  invalidOutput: boolean,
): ReviewFailureReason | undefined {
  if (hasEntries) return undefined
  if (attempt.termination === 'authentication-unavailable') return 'authentication-unavailable'
  if (attempt.termination === 'docker-unavailable') return 'docker-unavailable'
  if (attempt.termination === 'timed-out') return 'reviewer-timeout'
  if (attempt.termination === 'cancelled') return 'reviewer-cancelled'
  if (attempt.termination === 'crashed' || attempt.exitCode !== 0) return 'reviewer-crashed'
  return invalidOutput ? 'invalid-review-output' : 'reviewer-output-empty'
}

function compareCanonical(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right))
}

export async function validateReview(
  bundle: VerifiedReviewBundle,
  attempt: RawAttempt,
): Promise<ValidatedAttempt> {
  const verified = await readVerifiedReviewBundle(bundle)
  const observed = readReviewerRawAttempt(attempt)
  if (observed.bundleSha256 !== verified.sha256)
    throw new TypeError('review attempt belongs to a different verified bundle')
  if (
    canonicalJson(observed.reviewer.settings) !==
    canonicalJson(verified.manifest.plan.policies.reviewer)
  )
    throw new TypeError('review attempt reviewer differs from the planned policy')
  const parsed = readAuditDraft(
    observed.submissions,
    verified.manifest.inventory,
    observed.reviewId,
  )
  const executionFailed =
    observed.termination !== 'completed' ||
    observed.exitCode !== 0 ||
    observed.outputTruncated ||
    parsed.incomplete
  const outputIncomplete = observed.outputTruncated || parsed.incomplete || executionFailed
  const limitations: Limitation[] = [...verified.manifest.plan.limitations]
  if (outputIncomplete) {
    limitations.push({
      code: 'invalid-review-output',
      detail: 'Reviewer execution or semantic output was incomplete',
    })
  }
  const canonicalLimitations = limitations
    .filter(
      (item, index, all) =>
        all.findIndex(candidate => canonicalJson(candidate) === canonicalJson(item)) === index,
    )
    .sort(compareCanonical)
  const disposition: ReviewManifest['disposition'] =
    parsed.entries.length === 0 && parsed.summary === undefined
      ? 'failed'
      : canonicalLimitations.length > 0 ||
          verified.manifest.plan.inputProblems.length > 0 ||
          verified.manifest.plan.selections.some(
            selection => selection.coverageEffect === 'eligible-gap',
          )
        ? 'partial'
        : 'complete'
  const reason = failureReason(
    observed,
    parsed.entries.length > 0 || parsed.summary !== undefined,
    parsed.incomplete || observed.outputTruncated,
  )
  const subjectAttempt = {
    ...verified.manifest.plan.subjectAttempt,
    ...(verified.manifest.plan.subjectReview !== 'none' && outputIncomplete
      ? { effect: 'reviewed-partial' as const }
      : {}),
  }
  const manifest: ReviewManifest = {
    schemaVersion: 1,
    reviewId: observed.reviewId,
    ...verified.acceptance,
    patches: [...verified.acceptance.patches].sort(compareCanonical),
    sessionWatermarks: verified.manifest.plan.sessionWatermarks,
    coverageTargetWatermarks: verified.manifest.plan.coverageTargetWatermarks,
    subjectFingerprint: verified.manifest.plan.subjectFingerprint,
    subjectAttempt,
    evidenceSelections: verified.manifest.plan.selections,
    inputProblems: verified.manifest.plan.inputProblems,
    triggerIds: verified.manifest.plan.triggerIds,
    associationBatchIds: verified.manifest.plan.associationBatchIds,
    ...(verified.manifest.plan.priorLedger === undefined
      ? {}
      : { priorLedger: verified.manifest.plan.priorLedger.object }),
    limitations: canonicalLimitations,
    reviewer: observed.reviewer.settings,
    analyzerVersion: verified.manifest.plan.policies.analyzerVersion,
    promptVersion: verified.manifest.plan.policies.promptVersion,
    policyVersion: verified.manifest.plan.policies.policyVersion,
    formatVersion: 1,
    bundleSha256: verified.sha256,
    containerImageDigest: observed.imageDigest,
    providerCliVersion: observed.providerCliVersion,
    hostPlatform: observed.hostPlatform,
    startedAt: observed.startedAt,
    completedAt: observed.completedAt,
    disposition,
    ...(reason === undefined ? {} : { failureReason: reason }),
  }
  const ledger =
    disposition === 'failed'
      ? undefined
      : ({
          schemaVersion: 1,
          reviewId: observed.reviewId,
          entries: parsed.entries,
          ...(parsed.summary ? { summary: parsed.summary } : {}),
        } as const)
  const rootSegments =
    manifest.subject.kind === 'workspace'
      ? (['workspace', observed.reviewId] as const)
      : ([
          'pull-requests',
          'github',
          manifest.subject.repositoryKey,
          String(manifest.subject.number),
          observed.reviewId,
        ] as const)
  const capability = Object.freeze({}) as ValidatedAttempt
  validatedAttempts.set(capability, {
    manifest,
    ...(ledger === undefined ? {} : { ledger }),
    submissions: parsed.submissions,
    executionFailed,
    rootSegments,
    ...(verified.authority.repositoryId === undefined
      ? {}
      : { repositoryId: verified.authority.repositoryId }),
    subjectPath: verified.authority.subjectPath,
    subjectRecord: canonicalJson(verified.authority.subjectRecord),
    inventory: verified.authority.inventory,
    recordObjects: verified.authority.recordObjects,
    records: verified.authority.records,
  })
  return capability
}

export async function acceptReview(
  attempt: ValidatedAttempt,
  store: RepositoryStore,
): Promise<AcceptedReview> {
  const state = validatedAttempts.get(attempt)
  if (state === undefined) throw new TypeError('review attempt was not validated')
  const submissionsPath = makeOwnedPath('reviews', [...state.rootSegments, 'submissions.jsonl'])
  const manifestPath = makeOwnedPath('reviews', [...state.rootSegments, 'manifest.json'])
  const records = [
    { path: submissionsPath, bytes: state.submissions },
    ...(state.ledger === undefined
      ? []
      : [
          {
            path: makeOwnedPath('reviews', [...state.rootSegments, 'ledger.json']),
            bytes: new TextEncoder().encode(canonicalJson(state.ledger)),
          },
        ]),
    { path: manifestPath, bytes: new TextEncoder().encode(canonicalJson(state.manifest)) },
  ]
  await store.publishReview(
    {
      ...(state.repositoryId === undefined ? {} : { repositoryId: state.repositoryId }),
      subjectPath: state.subjectPath,
      subjectRecord: state.subjectRecord,
      records: state.records,
      inventory: state.inventory,
      recordObjects: state.recordObjects,
    },
    records,
    manifestPath,
  )
  if (state.ledger !== undefined) {
    await appendDecisionObservations(
      store,
      state.manifest,
      state.ledger,
      JSON.parse(state.subjectRecord),
    )
  }
  return {
    reviewId: state.manifest.reviewId,
    disposition: state.manifest.disposition,
    path: manifestPath,
    executionFailed: state.executionFailed || state.manifest.disposition === 'failed',
  }
}

function exactCoverageAction(
  review: ReviewManifest,
): Omit<CoverageAction, 'schemaVersion' | 'actionId' | 'createdAt'> {
  const acceptedTriggerIds = review.evidenceSelections
    .filter(
      selection =>
        selection.kind === 'opaque-problem' && selection.coverageEffect === 'eligible-gap',
    )
    .map(selection => selection.triggerId)
    .sort()
  const acceptedProblemIds = review.inputProblems.map(problem => problem.problemId).sort()
  const acceptedLimitations = [
    ...new Set([
      ...review.limitations.map(limitation => limitation.code),
      ...review.evidenceSelections
        .filter(selection => selection.coverageEffect === 'eligible-gap')
        .flatMap(selection => selection.limitations.map(limitation => limitation.code)),
      ...review.inputProblems.map(problem => problem.limitation.code),
    ]),
  ].sort()
  return {
    reviewId: review.reviewId,
    acceptedLimitations,
    acceptedTriggerIds,
    acceptedProblemIds,
    acceptedSubject: {
      fingerprint: review.subjectAttempt.fingerprint,
      coverageId: review.subjectAttempt.coverageId,
      limitations: [
        ...new Set(review.subjectAttempt.limitations.map(limitation => limitation.code)),
      ].sort(),
    },
    settledWatermarks: Object.fromEntries(
      Object.entries(review.coverageTargetWatermarks).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  }
}

function coverageActionId(reviewId: RecordId): RecordId {
  return `action_${reviewId.slice('review_'.length)}` as RecordId
}

export async function acceptPartialCoverage(
  store: RepositoryStore,
  request: PartialCoverageAcceptance,
): Promise<ReturnType<typeof makeOwnedPath>> {
  const records = await store.readRecords()
  const matches = loadStoredReviews(records.records).filter(
    review => review.manifest.reviewId === request.reviewId,
  )
  if (matches.length !== 1) throw new TypeError('coverage acceptance names no unique review')
  const review = matches[0]!.manifest
  if (review.disposition !== 'partial')
    throw new TypeError('coverage acceptance requires a partial review')
  if (canonicalJson(review.subject) !== canonicalJson(request.subject))
    throw new TypeError('coverage acceptance names the wrong subject')
  const expected = exactCoverageAction(review)
  const supplied = {
    reviewId: request.reviewId,
    acceptedLimitations: [...new Set(request.acceptedLimitations)].sort(),
    acceptedTriggerIds: [...new Set(request.acceptedTriggerIds)].sort(),
    acceptedProblemIds: [...new Set(request.acceptedProblemIds)].sort() as Sha256[],
    ...(request.acceptedSubject === undefined
      ? {}
      : {
          acceptedSubject: {
            ...request.acceptedSubject,
            limitations: [...new Set(request.acceptedSubject.limitations)].sort(),
          },
        }),
    settledWatermarks: Object.fromEntries(
      Object.entries(request.settledWatermarks).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  }
  if (canonicalJson(expected) !== canonicalJson(supplied)) {
    throw new TypeError('coverage acceptance must acknowledge the exact partial review gaps')
  }
  const semantic: Omit<CoverageAction, 'createdAt'> = {
    schemaVersion: 1,
    actionId: coverageActionId(request.reviewId),
    ...expected,
  }
  return (await store.createCoverageAction(semantic)).path
}

/** Explicitly accept every exact blocking gap recorded by one partial review. */
export async function acceptPartialCoverageByReviewId(
  store: RepositoryStore,
  reviewId: RecordId,
): Promise<ReturnType<typeof makeOwnedPath>> {
  const records = await store.readRecords()
  const matches = loadStoredReviews(records.records).filter(
    review => review.manifest.reviewId === reviewId,
  )
  if (matches.length !== 1) throw new TypeError('coverage acceptance names no unique review')
  const review = matches[0]!.manifest
  if (review.disposition !== 'partial')
    throw new TypeError('coverage acceptance requires a partial review')
  const exact = exactCoverageAction(review)
  return await acceptPartialCoverage(store, { ...exact, subject: review.subject })
}
