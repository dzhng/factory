import {
  canonicalJson,
  makeOwnedPath,
  readAuditDraft,
  validatePublicRecord,
  type CoverageAction,
  type Limitation,
  type RecordId,
  type ReviewFailureReason,
  type ReviewLedger,
  type ReviewManifest,
  type Sha256,
  type DecisionObservation,
} from '@factory/contract'
import { deriveDecisionObservations, loadStoredReviews } from '@factory/domain'
import {
  snapshotPreparedRecord,
  type PreparedRecord,
  type RepositoryStore,
} from '@factory/repository'
import {
  readVerifiedReviewBundle,
  readReviewerRawAttempt,
  type ReviewerRawAttempt,
  type ReviewerRawAttemptSnapshot,
  type VerifiedReviewBundle,
  type ReviewAttemptCoordinator,
} from '@factory/reviewer'

import { prepareAuditDraft, type ReviewSanitizer } from './preparation'

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

type PreparedReview = {
  manifest: ReviewManifest
  ledger?: ReviewLedger
  submissions: Uint8Array
  decisionObservations: readonly DecisionObservation[]
  executionFailed: boolean
  rootSegments: readonly string[]
}

type ValidatedState = PreparedReview & {
  publication?: readonly PreparedRecord[]
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
  options:
    | { sanitizer: ReviewSanitizer }
    | {
        store: RepositoryStore
        coordinator: ReviewAttemptCoordinator
        retryGeneration?: RecordId
      },
): Promise<ValidatedAttempt> {
  let prepared: PreparedReview
  let publication: readonly PreparedRecord[] | undefined
  if ('sanitizer' in options)
    prepared = await buildPreparedReview(bundle, attempt, options.sanitizer)
  else {
    publication = await options.coordinator.preparePublication(
      bundle,
      attempt,
      async () => {
        const context = await options.store.preparePublication()
        const prepared = await buildPreparedReview(bundle, attempt, context.sanitizer)
        return reviewRecords(prepared).map(record =>
          context.prepareRecord(record.path, record.bytes),
        )
      },
      options.retryGeneration,
    )
    const snapshots = publication.map(record => snapshotPreparedRecord(record))
    const manifestRecord = snapshots.find(
      record => record.path.startsWith('reviews/') && record.path.endsWith('/manifest.json'),
    )
    if (manifestRecord === undefined) throw new TypeError('prepared review lacks its manifest')
    const manifest = JSON.parse(new TextDecoder().decode(manifestRecord.bytes)) as ReviewManifest
    const rootSegments = reviewRootSegments(manifest)
    const submissions = snapshots.find(
      record => record.path === makeOwnedPath('reviews', [...rootSegments, 'submissions.jsonl']),
    )?.bytes
    const ledger = snapshots.find(
      record => record.path === makeOwnedPath('reviews', [...rootSegments, 'ledger.json']),
    )
    if (submissions === undefined) throw new TypeError('prepared review lacks its submissions')
    prepared = {
      manifest,
      rootSegments,
      submissions,
      ...(ledger === undefined
        ? {}
        : { ledger: JSON.parse(new TextDecoder().decode(ledger.bytes)) as ReviewLedger }),
      decisionObservations: snapshots
        .filter(record => record.path.startsWith('decisions/observations/'))
        .map(record => JSON.parse(new TextDecoder().decode(record.bytes)) as DecisionObservation),
      executionFailed: manifest.limitations.some(
        limitation => limitation.code === 'invalid-review-output',
      ),
    }
    const expected = reviewRecords(prepared)
    if (
      expected.length !== snapshots.length ||
      expected.some(
        (record, index) =>
          record.path !== snapshots[index]!.path ||
          !Buffer.from(record.bytes).equals(snapshots[index]!.bytes),
      )
    )
      throw new TypeError('prepared review publication differs from its exact graph')
  }
  const verified = await readVerifiedReviewBundle(bundle)
  const state: ValidatedState = {
    ...prepared,
    ...(publication === undefined ? {} : { publication }),
    ...(verified.authority.repositoryId === undefined
      ? {}
      : { repositoryId: verified.authority.repositoryId }),
    subjectPath: verified.authority.subjectPath,
    subjectRecord: canonicalJson(verified.authority.subjectRecord),
    inventory: verified.authority.inventory,
    recordObjects: verified.authority.recordObjects,
    records: verified.authority.records,
  }
  const observed = readReviewerRawAttempt(attempt)
  if (
    state.manifest.reviewId !== observed.reviewId ||
    state.manifest.bundleSha256 !== verified.sha256 ||
    canonicalJson({
      subject: state.manifest.subject,
      head: state.manifest.head ?? null,
      codeManifest: state.manifest.codeManifest ?? null,
      patches: state.manifest.patches,
    }) !==
      canonicalJson({
        subject: verified.acceptance.subject,
        head: verified.acceptance.head ?? null,
        codeManifest: verified.acceptance.codeManifest ?? null,
        patches: [...verified.acceptance.patches].sort(compareCanonical),
      })
  )
    throw new TypeError('prepared review publication differs from bundle authority')
  validatePublicRecord(
    makeOwnedPath('reviews', [...state.rootSegments, 'manifest.json']),
    state.manifest,
  )
  if (state.ledger !== undefined) {
    validatePublicRecord(
      makeOwnedPath('reviews', [...state.rootSegments, 'ledger.json']),
      state.ledger,
    )
    const rebuilt = readAuditDraft(
      state.submissions,
      verified.manifest.inventory,
      observed.reviewId,
    )
    if (
      canonicalJson(rebuilt.entries) !== canonicalJson(state.ledger.entries) ||
      canonicalJson(rebuilt.summary ?? null) !== canonicalJson(state.ledger.summary ?? null)
    )
      throw new TypeError('prepared review ledger differs from submissions')
  }
  const observations =
    state.ledger === undefined
      ? []
      : deriveDecisionObservations(state.manifest, state.ledger, verified.authority.subjectRecord)
  if (canonicalJson(state.decisionObservations) !== canonicalJson(observations))
    throw new TypeError('prepared decisions differ from their review authority')
  const capability = Object.freeze({}) as ValidatedAttempt
  validatedAttempts.set(capability, state)
  return capability
}

async function buildPreparedReview(
  bundle: VerifiedReviewBundle,
  attempt: RawAttempt,
  sanitizer: ReviewSanitizer,
): Promise<PreparedReview> {
  const verified = await readVerifiedReviewBundle(bundle)
  const observed = readReviewerRawAttempt(attempt)
  if (observed.bundleSha256 !== verified.sha256)
    throw new TypeError('review attempt belongs to a different verified bundle')
  if (
    canonicalJson(observed.reviewer.settings) !==
    canonicalJson(verified.manifest.plan.policies.reviewer)
  )
    throw new TypeError('review attempt reviewer differs from the planned policy')
  const parsed = prepareAuditDraft(
    observed.submissions,
    verified.manifest.inventory,
    observed.reviewId,
    sanitizer,
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
  const providerCliVersion =
    observed.providerCliVersion === null ? null : sanitizer.text(observed.providerCliVersion)
  const hostPlatform = sanitizer.text(observed.hostPlatform)
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
    providerCliVersion: providerCliVersion?.text ?? null,
    hostPlatform: hostPlatform.text,
    startedAt: observed.startedAt,
    completedAt: observed.completedAt,
    disposition,
    transformation: {
      policy: 'evidence-sanitization-1',
      redacted: parsed.redacted || providerCliVersion?.redacted === true || hostPlatform.redacted,
      omittedCharacters: 0,
      omissionReasons: parsed.omissionReasons,
    },
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
  const rootSegments = reviewRootSegments(manifest)
  return {
    manifest,
    ...(ledger === undefined ? {} : { ledger }),
    submissions: parsed.submissions,
    decisionObservations:
      ledger === undefined
        ? []
        : deriveDecisionObservations(manifest, ledger, verified.authority.subjectRecord),
    executionFailed,
    rootSegments,
  }
}

function reviewRootSegments(manifest: ReviewManifest): readonly string[] {
  return manifest.subject.kind === 'workspace'
    ? ['workspace', manifest.reviewId]
    : [
        'pull-requests',
        'github',
        manifest.subject.repositoryKey,
        String(manifest.subject.number),
        manifest.reviewId,
      ]
}

function reviewRecords(state: PreparedReview) {
  const submissionsPath = makeOwnedPath('reviews', [...state.rootSegments, 'submissions.jsonl'])
  const manifestPath = makeOwnedPath('reviews', [...state.rootSegments, 'manifest.json'])
  return [
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
    ...state.decisionObservations.map(observation => ({
      path: makeOwnedPath('decisions', ['observations', `${observation.observationId}.json`]),
      bytes: new TextEncoder().encode(canonicalJson(observation)),
    })),
  ]
}

export async function acceptReview(
  attempt: ValidatedAttempt,
  store: RepositoryStore,
): Promise<AcceptedReview> {
  const state = validatedAttempts.get(attempt)
  if (state === undefined) throw new TypeError('review attempt was not validated')
  let publication = state.publication
  if (publication === undefined) {
    const context = await store.preparePublication()
    publication = reviewRecords(state).map(record =>
      context.prepareRecord(record.path, record.bytes),
    )
  }
  const manifestPath = makeOwnedPath('reviews', [...state.rootSegments, 'manifest.json'])
  await store.publishReview(
    {
      ...(state.repositoryId === undefined ? {} : { repositoryId: state.repositoryId }),
      subjectPath: state.subjectPath,
      subjectRecord: state.subjectRecord,
      records: state.records,
      inventory: state.inventory,
      recordObjects: state.recordObjects,
    },
    publication.filter(record => record.path.startsWith('reviews/')),
    manifestPath,
  )
  for (const record of publication.filter(record => record.path.startsWith('decisions/')))
    await store.createImmutable(record)
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
