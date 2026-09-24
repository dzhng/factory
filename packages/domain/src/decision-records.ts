import {
  canonicalJson,
  type DecisionAction,
  type DecisionObservation,
  type RepositoryRecords,
} from '@factory/contract'

import { deriveDecisionObservations, foldDecisions } from './decisions'
import { loadStoredReviews, resolveStoredReviewSubject } from './stored-reviews'

/** Derive the decision observations that exact accepted review groups require. */
function deriveStoredDecisionObservations(
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

/** Accepted reviews own observations; only human actions are separate records. */
export function loadDecisionHistory(records: RepositoryRecords): {
  observations: DecisionObservation[]
  actions: DecisionAction[]
} {
  const actions: DecisionAction[] = []
  for (const record of records.records) {
    if (/^decisions\/actions\/[^/]+\.json$/.test(record.path))
      actions.push(record.value as DecisionAction)
  }
  return { observations: [...deriveStoredDecisionObservations(records)], actions }
}

/** Project validated repository records through the one pure decision fold. */
export function foldStoredDecisions(records: RepositoryRecords, canonicalBranch: string) {
  const { observations, actions } = loadDecisionHistory(records)
  return foldDecisions(observations, actions, canonicalBranch)
}
