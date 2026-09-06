import {
  canonicalJson,
  type DecisionAction,
  type DecisionObservation,
  type RepositoryRecords,
} from '@factory/contract'

import { deriveDecisionObservations, foldDecisions } from './decisions'
import { loadStoredReviews, resolveStoredReviewSubject } from './stored-reviews'

/** Derive the decision observations that exact accepted review groups require. */
export function deriveStoredDecisionObservations(
  records: RepositoryRecords,
): readonly DecisionObservation[] {
  const expected = new Map<string, DecisionObservation>()
  for (const review of loadStoredReviews(records.records)) {
    if (review.ledger === undefined) continue
    for (const observation of deriveDecisionObservations(
      review.manifest,
      review.ledger,
      (review.subject ?? resolveStoredReviewSubject(review.manifest, records)).observation,
    )) {
      const prior = expected.get(observation.observationId)
      if (prior !== undefined && canonicalJson(prior) !== canonicalJson(observation))
        throw new TypeError('accepted reviews derive conflicting decision observations')
      expected.set(observation.observationId, observation)
    }
  }
  return [...expected.values()].sort((left, right) =>
    left.observationId.localeCompare(right.observationId),
  )
}

/** Load decision records only when every accepted review derivation is exactly recovered. */
export function loadVerifiedDecisionRecords(records: RepositoryRecords): {
  observations: DecisionObservation[]
  actions: DecisionAction[]
} {
  const observations: DecisionObservation[] = []
  const actions: DecisionAction[] = []
  for (const record of records.records) {
    if (/^decisions\/observations\/[^/]+\.json$/.test(record.path))
      observations.push(record.value as unknown as DecisionObservation)
    if (/^decisions\/actions\/[^/]+\.json$/.test(record.path))
      actions.push(record.value as DecisionAction)
  }
  const expected = new Map(
    deriveStoredDecisionObservations(records).map(observation => [
      observation.observationId,
      observation,
    ]),
  )
  const actual = new Map(observations.map(observation => [observation.observationId, observation]))
  for (const observation of observations) {
    const source = expected.get(observation.observationId)
    if (source === undefined || canonicalJson(source) !== canonicalJson(observation))
      throw new TypeError('decision observation is not derived from its accepted review entry')
  }
  for (const observationId of expected.keys()) {
    if (!actual.has(observationId))
      throw new TypeError('accepted review decision observation has not been recovered')
  }
  return { observations, actions }
}

/** Project validated repository records through the one pure decision fold. */
export function foldStoredDecisions(records: RepositoryRecords, canonicalBranch: string) {
  const { observations, actions } = loadVerifiedDecisionRecords(records)
  return foldDecisions(observations, actions, canonicalBranch)
}
