import {
  canonicalJson,
  type AvailablePullRequestObservation,
  type CoverageAction,
  type Limitation,
  type LimitationCode,
  type RecordId,
  type RepositoryObservation,
  type ReviewEvidenceSelection,
  type ReviewInputProblem,
} from '@factory/contract'

export type CoverageSubject =
  | { kind: 'workspace'; observation: RepositoryObservation }
  | { kind: 'pull-request'; observation: AvailablePullRequestObservation }

export type CoverageSubjectAttempt = {
  fingerprint: string
  coverageId: string
  effect: 'current-included' | 'reviewed-partial' | 'previously-analyzed-unsettled' | 'settled'
  limitations: readonly Limitation[]
}

export type PriorCoverageReview = {
  reviewId: RecordId
  subject: CoverageSubject
  subjectFingerprint: string
  subjectAttempt: CoverageSubjectAttempt
  sessionWatermarks: Readonly<Record<string, number>>
  coverageTargetWatermarks: Readonly<Record<string, number>>
  selections: readonly ReviewEvidenceSelection[]
  inputProblems: readonly ReviewInputProblem[]
  limitations?: readonly Limitation[]
  triggerIds: readonly RecordId[]
  disposition: 'complete' | 'partial' | 'failed'
}

export type CoverageFoldInput = {
  subject: CoverageSubject
  reviews: readonly PriorCoverageReview[]
  coverageActions: readonly CoverageAction[]
}

export type CoverageView = {
  settledWatermarks: Readonly<Record<string, number>>
  reviewedWatermarks: Readonly<Record<string, readonly number[]>>
  acceptedTriggerIds: readonly RecordId[]
  acceptedProblemIds: readonly string[]
  priorSelections: Readonly<Record<string, ReviewEvidenceSelection>>
  subject?: CoverageSubjectAttempt
}

const compareCanonical = (left: unknown, right: unknown) =>
  canonicalJson(left).localeCompare(canonicalJson(right))

function sameSubject(review: PriorCoverageReview, subject: CoverageSubject): boolean {
  if (review.subject.kind !== subject.kind) return false
  if (subject.kind === 'workspace')
    return (
      review.subject.kind === 'workspace' &&
      review.subject.observation.repositoryId === subject.observation.repositoryId
    )
  return (
    review.subject.kind === 'pull-request' &&
    review.subject.observation.repositoryKey === subject.observation.repositoryKey &&
    review.subject.observation.number === subject.observation.number
  )
}

function acceptedReviewWatermarks(review: PriorCoverageReview): Map<string, Set<number>> {
  const accepted = new Map<string, Set<number>>()
  if (review.disposition === 'failed') return accepted
  for (const selection of review.selections) {
    if (selection.kind !== 'range') continue
    if (!selection.selectedForReview) continue
    if (!['eligible-included', 'eligible-gap'].includes(selection.coverageEffect)) continue
    const values = accepted.get(selection.sessionKey) ?? new Set<number>()
    values.add(selection.evidenceWatermark)
    accepted.set(selection.sessionKey, values)
  }
  return accepted
}

function assertExactAttemptMetadata(review: PriorCoverageReview): void {
  const attempted = review.selections.filter(selection =>
    ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect),
  )
  const watermarks = Object.fromEntries(
    [
      ...new Set(
        attempted
          .filter(selection => selection.kind === 'range')
          .map(selection => selection.sessionKey),
      ),
    ]
      .sort()
      .map(sessionKey => [
        sessionKey,
        Math.max(
          ...attempted
            .filter(
              (selection): selection is ReviewEvidenceSelection & { kind: 'range' } =>
                selection.kind === 'range' && selection.sessionKey === sessionKey,
            )
            .map(selection => selection.evidenceWatermark),
        ),
      ]),
  )
  if (canonicalJson(watermarks) !== canonicalJson(review.sessionWatermarks)) {
    throw new TypeError('prior review watermarks differ from exact attempted selections')
  }
  const triggerIds = attempted.map(selection => selection.triggerId).sort()
  if (canonicalJson(triggerIds) !== canonicalJson(review.triggerIds)) {
    throw new TypeError('prior review trigger IDs differ from exact attempted selections')
  }
  const targets = Object.fromEntries(
    [
      ...new Set(
        review.selections
          .filter(selection => selection.kind === 'range')
          .filter(selection =>
            [
              'eligible-included',
              'eligible-gap',
              'previously-analyzed-complete',
              'previously-analyzed-partial',
              'settled',
            ].includes(selection.coverageEffect),
          )
          .map(selection => (selection.kind === 'range' ? selection.sessionKey : '')),
      ),
    ]
      .filter(Boolean)
      .sort()
      .map(sessionKey => [
        sessionKey,
        Math.max(
          ...review.selections
            .filter(
              (selection): selection is ReviewEvidenceSelection & { kind: 'range' } =>
                selection.kind === 'range' &&
                selection.sessionKey === sessionKey &&
                [
                  'eligible-included',
                  'eligible-gap',
                  'previously-analyzed-complete',
                  'previously-analyzed-partial',
                  'settled',
                ].includes(selection.coverageEffect),
            )
            .map(selection => selection.evidenceWatermark),
        ),
      ]),
  )
  if (canonicalJson(targets) !== canonicalJson(review.coverageTargetWatermarks)) {
    throw new TypeError('prior review coverage targets differ from exact prefix closure')
  }
}

function exactBlockingCodes(
  review: PriorCoverageReview,
  watermarkBySession: Readonly<Record<string, number>>,
  acceptedTriggerIds: readonly RecordId[],
  acceptedProblemIds: readonly string[],
): LimitationCode[] {
  return [
    ...new Set([
      ...review.selections
        .filter(
          selection =>
            selection.kind === 'range' &&
            selection.evidenceWatermark <= (watermarkBySession[selection.sessionKey] ?? -1),
        )
        .filter(selection => selection.coverageEffect === 'eligible-gap')
        .flatMap(selection => selection.limitations.map(limitation => limitation.code)),
      ...(review.limitations ?? []).map(limitation => limitation.code),
      ...review.inputProblems
        .filter(problem => acceptedProblemIds.includes(problem.problemId))
        .map(problem => problem.limitation.code),
      ...review.selections
        .filter(
          selection =>
            selection.kind === 'opaque-problem' && acceptedTriggerIds.includes(selection.triggerId),
        )
        .flatMap(selection => selection.limitations.map(limitation => limitation.code)),
    ]),
  ].sort()
}

/** Fold accepted coverage and analyzed ranges without editing append-only reviews or triggers. */
export function foldCoverage(input: CoverageFoldInput): CoverageView {
  const settled: Record<string, number> = {}
  const reviewed = new Map<string, Set<number>>()
  const acceptedOpaque = new Set<RecordId>()
  const acceptedProblems = new Set<string>()
  const priorSelections = new Map<RecordId, ReviewEvidenceSelection>()
  let subjectCoverage: CoverageSubjectAttempt | undefined
  const allReviews = [...input.reviews].sort((left, right) =>
    left.reviewId.localeCompare(right.reviewId),
  )
  if (new Set(allReviews.map(review => review.reviewId)).size !== allReviews.length) {
    throw new TypeError('prior review identity is not unique')
  }
  const reviews = allReviews.filter(review => sameSubject(review, input.subject))
  for (const review of reviews) {
    assertExactAttemptMetadata(review)
    if (
      review.subjectAttempt.fingerprint !== review.subjectFingerprint ||
      canonicalJson(review.subjectAttempt.limitations) !==
        canonicalJson([...review.subjectAttempt.limitations].sort(compareCanonical))
    ) {
      throw new TypeError('prior review subject attempt is invalid')
    }
    if (review.disposition !== 'failed') {
      subjectCoverage = {
        ...review.subjectAttempt,
        effect:
          review.subjectAttempt.effect === 'settled' ||
          (review.subjectAttempt.effect === 'current-included' &&
            review.subjectAttempt.limitations.length === 0 &&
            !(review.limitations ?? []).some(
              limitation => limitation.code === 'invalid-review-output',
            ))
            ? 'settled'
            : review.subjectAttempt.effect,
      }
      for (const selection of review.selections) {
        if (
          selection.selectedForReview &&
          ['eligible-included', 'eligible-gap', 'context-only'].includes(selection.coverageEffect)
        ) {
          priorSelections.set(selection.triggerId, selection)
        }
      }
    }
    if (review.disposition === 'complete') {
      for (const [sessionKey, watermark] of Object.entries(review.coverageTargetWatermarks)) {
        const priorReviewed = reviewed.get(sessionKey) ?? new Set<number>()
        const selections = review.selections.filter(
          (item): item is ReviewEvidenceSelection & { kind: 'range' } =>
            item.kind === 'range' &&
            item.sessionKey === sessionKey &&
            item.evidenceWatermark <= watermark,
        )
        if (
          selections.length === 0 ||
          selections.some(
            item =>
              item.coverageEffect !== 'eligible-included' &&
              !(
                ['previously-analyzed-complete', 'settled'].includes(item.coverageEffect) &&
                (item.evidenceWatermark <= (settled[sessionKey] ?? 0) ||
                  priorReviewed.has(item.evidenceWatermark))
              ),
          )
        ) {
          throw new TypeError('complete review contains an unsettled evidence selection')
        }
        settled[sessionKey] = Math.max(settled[sessionKey] ?? 0, watermark)
        for (const selection of selections) {
          if (selection.coverageEffect === 'eligible-included') {
            acceptedOpaque.add(selection.triggerId)
          }
        }
      }
      if (
        review.selections.some(
          selection =>
            selection.kind === 'opaque-problem' && selection.coverageEffect === 'eligible-gap',
        )
      ) {
        throw new TypeError('complete review contains an opaque attempted problem')
      }
    }
    for (const [sessionKey, values] of acceptedReviewWatermarks(review)) {
      const existing = reviewed.get(sessionKey) ?? new Set<number>()
      values.forEach(value => existing.add(value))
      reviewed.set(sessionKey, existing)
    }
  }
  const byId = new Map(allReviews.map(review => [review.reviewId, review]))
  for (const action of [...input.coverageActions].sort((a, b) =>
    a.actionId.localeCompare(b.actionId),
  )) {
    const review = byId.get(action.reviewId)
    if (review === undefined) throw new TypeError('coverage action names no review')
    if (!sameSubject(review, input.subject)) continue
    if (review.disposition !== 'partial') {
      throw new TypeError('coverage action must name one partial review')
    }
    for (const [sessionKey, watermark] of Object.entries(action.settledWatermarks)) {
      if (watermark > (review.coverageTargetWatermarks[sessionKey] ?? -1)) {
        throw new TypeError('coverage action exceeds its review watermark')
      }
      if (
        !review.selections.some(
          selection =>
            selection.kind === 'range' &&
            selection.sessionKey === sessionKey &&
            selection.evidenceWatermark === watermark &&
            [
              'eligible-included',
              'eligible-gap',
              'previously-analyzed-complete',
              'settled',
            ].includes(selection.coverageEffect),
        )
      ) {
        throw new TypeError('coverage action watermark must name an exact eligible boundary')
      }
    }
    const opaqueBlocking = review.selections
      .filter(
        selection =>
          selection.kind === 'opaque-problem' && selection.coverageEffect === 'eligible-gap',
      )
      .map(selection => selection.triggerId)
      .sort()
    const acceptedIds = [...new Set(action.acceptedTriggerIds)].sort()
    if (acceptedIds.some(id => !opaqueBlocking.includes(id))) {
      throw new TypeError('coverage action names an unattempted opaque trigger')
    }
    const acceptedProblemIds = [...new Set(action.acceptedProblemIds)].sort()
    if (
      acceptedProblemIds.some(id => !review.inputProblems.some(problem => problem.problemId === id))
    )
      throw new TypeError('coverage action names an unknown input problem')
    const expectedCodes = exactBlockingCodes(
      review,
      action.settledWatermarks,
      acceptedIds,
      acceptedProblemIds,
    )
    const actualCodes = [...new Set(action.acceptedLimitations)].sort()
    if (canonicalJson(expectedCodes) !== canonicalJson(actualCodes)) {
      throw new TypeError('coverage action must accept the exact blocking limitations')
    }
    for (const [sessionKey, watermark] of Object.entries(action.settledWatermarks)) {
      settled[sessionKey] = Math.max(settled[sessionKey] ?? 0, watermark)
    }
    acceptedIds.forEach(id => acceptedOpaque.add(id))
    acceptedProblemIds.forEach(id => acceptedProblems.add(id))
    for (const selection of review.selections) {
      if (
        selection.kind === 'range' &&
        selection.coverageEffect === 'eligible-gap' &&
        selection.evidenceWatermark <= (action.settledWatermarks[selection.sessionKey] ?? -1)
      ) {
        acceptedOpaque.add(selection.triggerId)
      }
    }
    if (action.acceptedSubject !== undefined) {
      if (
        action.acceptedSubject.fingerprint !== review.subjectAttempt.fingerprint ||
        action.acceptedSubject.coverageId !== review.subjectAttempt.coverageId
      ) {
        throw new TypeError('coverage action subject fingerprint differs from its review')
      }
      const expected = [
        ...new Set(review.subjectAttempt.limitations.map(limitation => limitation.code)),
      ].sort()
      const actual = [...new Set(action.acceptedSubject.limitations)].sort()
      if (canonicalJson(expected) !== canonicalJson(actual)) {
        throw new TypeError('coverage action must accept exact subject limitations')
      }
      subjectCoverage = { ...review.subjectAttempt, effect: 'settled' }
    }
  }
  return {
    settledWatermarks: Object.fromEntries(Object.entries(settled).sort()),
    reviewedWatermarks: Object.fromEntries(
      [...reviewed]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, values]) => [key, [...values].sort((left, right) => left - right)]),
    ),
    acceptedTriggerIds: [...acceptedOpaque].sort(),
    acceptedProblemIds: [...acceptedProblems].sort(),
    priorSelections: Object.fromEntries(
      [...priorSelections].sort(([left], [right]) => left.localeCompare(right)),
    ),
    ...(subjectCoverage === undefined ? {} : { subject: subjectCoverage }),
  }
}
