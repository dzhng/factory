import { createHash } from 'node:crypto'

import {
  canonicalJson,
  makeOwnedPath,
  validatePublicRecord,
  type AssociationBatch,
  type PullRequestObservation,
  type SessionPullRequestAssociation,
} from '@factory/contract'

/** Verify a completed association batch before its evidence enters any projection. */
export function verifyAssociationBatch(
  batch: AssociationBatch,
  observation: PullRequestObservation,
  records: readonly SessionPullRequestAssociation[],
): boolean {
  try {
    validatePublicRecord(
      makeOwnedPath('pull-requests', [
        'github',
        observation.repositoryKey,
        String(observation.number),
        'observations',
        `${observation.observationId}.json`,
      ]),
      observation,
    )
    if (
      batch.repositoryKey !== observation.repositoryKey ||
      batch.number !== observation.number ||
      batch.pullRequestObservationId !== observation.observationId
    )
      return false
    validatePublicRecord(
      makeOwnedPath('pull-requests', [
        'github',
        batch.repositoryKey,
        String(batch.number),
        'associations',
        batch.pullRequestObservationId,
        'batches',
        `${batch.batchId}.json`,
      ]),
      batch,
    )
  } catch {
    return false
  }
  if (batch.evidence.length !== records.length) return false
  if (new Set(records.map(record => record.evidenceId)).size !== records.length) return false
  if (new Set(batch.evidence.map(entry => entry.evidenceId)).size !== batch.evidence.length)
    return false
  const expectedKind = batch.kind === 'manual' ? 'manual' : 'automatic'
  if (
    records.some(
      record =>
        record.pullRequestObservationId !== batch.pullRequestObservationId ||
        record.observedAt !== batch.observedAt ||
        (record.kind === 'manual' ? 'manual' : 'automatic') !== expectedKind,
    )
  )
    return false
  const sources = [...new Set(records.flatMap(record => record.sourceObservationIds))].sort()
  if (canonicalJson(sources) !== canonicalJson(batch.sourceObservationIds)) return false
  const byId = new Map(records.map(record => [record.evidenceId, record]))
  return batch.evidence.every(entry => {
    const record = byId.get(entry.evidenceId)
    if (record === undefined) return false
    try {
      validatePublicRecord(
        makeOwnedPath('pull-requests', [
          'github',
          batch.repositoryKey,
          String(batch.number),
          'associations',
          batch.pullRequestObservationId,
          `${record.evidenceId}.json`,
        ]),
        record,
      )
    } catch {
      return false
    }
    return createHash('sha256').update(canonicalJson(record)).digest('hex') === entry.sha256
  })
}
