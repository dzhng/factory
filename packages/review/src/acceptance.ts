import {
  canonicalJson,
  makeOwnedPath,
  type CoverageAction,
  type Limitation,
  type RecordId,
  type ReviewFailureReason,
  type ReviewLedger,
  type ReviewManifest,
} from '@factory/contract'
import type { RepositoryStore } from '@factory/repository'
import {
  readVerifiedReviewBundle,
  type ReviewerChoice,
  type VerifiedReviewBundle,
} from '@factory/reviewer'

import { parseSemanticOutput } from './output'

export type AttemptTermination =
  | 'completed'
  | 'timed-out'
  | 'cancelled'
  | 'crashed'
  | 'authentication-unavailable'
  | 'docker-unavailable'

export type RawAttempt = {
  reviewId: RecordId
  response: Uint8Array
  termination: AttemptTermination
  exitCode: number | null
  outputTruncated: boolean
  reviewer: ReviewerChoice
  imageDigest: string
  providerCliVersion: string
  hostPlatform: string
  startedAt: string
  completedAt: string
}

export type AcceptedReview = {
  reviewId: RecordId
  disposition: ReviewManifest['disposition']
  path: ReturnType<typeof makeOwnedPath>
  executionFailed: boolean
}

declare const validatedAttemptBrand: unique symbol
export type ValidatedAttempt = { readonly [validatedAttemptBrand]: true }

type ValidatedState = {
  manifest: ReviewManifest
  ledger?: ReviewLedger
  response: Uint8Array
  executionFailed: boolean
  rootSegments: readonly string[]
}

const validatedAttempts = new WeakMap<object, ValidatedState>()

function failureReason(
  attempt: RawAttempt,
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
  if (
    canonicalJson(attempt.reviewer.settings) !==
    canonicalJson(verified.manifest.plan.policies.reviewer)
  )
    throw new TypeError('review attempt reviewer differs from the planned policy')
  const parsed = parseSemanticOutput(
    attempt.response,
    verified.manifest.inventory,
    attempt.reviewId,
  )
  const executionFailed =
    attempt.termination !== 'completed' ||
    attempt.exitCode !== 0 ||
    attempt.outputTruncated ||
    parsed.incomplete
  const outputIncomplete = attempt.outputTruncated || parsed.incomplete || executionFailed
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
    parsed.entries.length === 0
      ? 'failed'
      : canonicalLimitations.length > 0 ||
          verified.manifest.plan.inputProblems.length > 0 ||
          verified.manifest.plan.selections.some(
            selection => selection.coverageEffect === 'eligible-gap',
          )
        ? 'partial'
        : 'complete'
  const reason = failureReason(
    attempt,
    parsed.entries.length > 0,
    parsed.incomplete || attempt.outputTruncated,
  )
  const subjectAttempt = {
    ...verified.manifest.plan.subjectAttempt,
    ...(disposition === 'partial' ? { effect: 'reviewed-partial' as const } : {}),
  }
  const manifest: ReviewManifest = {
    schemaVersion: 1,
    reviewId: attempt.reviewId,
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
    reviewer: attempt.reviewer.settings,
    analyzerVersion: verified.manifest.plan.policies.analyzerVersion,
    promptVersion: verified.manifest.plan.policies.promptVersion,
    policyVersion: verified.manifest.plan.policies.policyVersion,
    formatVersion: 1,
    bundleSha256: verified.sha256,
    containerImageDigest: attempt.imageDigest,
    providerCliVersion: attempt.providerCliVersion,
    hostPlatform: attempt.hostPlatform,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    disposition,
    ...(reason === undefined ? {} : { failureReason: reason }),
  }
  const ledger =
    disposition === 'failed'
      ? undefined
      : ({ schemaVersion: 1, reviewId: attempt.reviewId, entries: parsed.entries } as const)
  const rootSegments =
    manifest.subject.kind === 'workspace'
      ? (['workspace', attempt.reviewId] as const)
      : ([
          'pull-requests',
          'github',
          manifest.subject.repositoryKey,
          String(manifest.subject.number),
          attempt.reviewId,
        ] as const)
  const capability = Object.freeze({}) as ValidatedAttempt
  validatedAttempts.set(capability, {
    manifest,
    ...(ledger === undefined ? {} : { ledger }),
    response: attempt.response.slice(),
    executionFailed,
    rootSegments,
  })
  return capability
}

export async function acceptReview(
  attempt: ValidatedAttempt,
  store: RepositoryStore,
): Promise<AcceptedReview> {
  const state = validatedAttempts.get(attempt)
  if (state === undefined) throw new TypeError('review attempt was not validated')
  const responsePath = makeOwnedPath('reviews', [...state.rootSegments, 'response.txt'])
  const manifestPath = makeOwnedPath('reviews', [...state.rootSegments, 'manifest.json'])
  const records = [
    { path: responsePath, bytes: state.response },
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
  await store.publishImmutableGroup(records, manifestPath)
  return {
    reviewId: state.manifest.reviewId,
    disposition: state.manifest.disposition,
    path: manifestPath,
    executionFailed: state.executionFailed || state.manifest.disposition === 'failed',
  }
}

export async function acceptPartialCoverage(
  store: RepositoryStore,
  action: CoverageAction,
): Promise<ReturnType<typeof makeOwnedPath>> {
  const path = makeOwnedPath('reviews', ['coverage-actions', `${action.actionId}.json`])
  await store.createImmutable(path, new TextEncoder().encode(canonicalJson(action)))
  return path
}
