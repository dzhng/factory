import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'

import {
  canonicalJson,
  makeOwnedPath,
  readAuditDraft,
  validatePublicRecord,
  type DecisionAction,
  type DecisionObservation,
  type OwnedPath,
  type RecordId,
} from '@factory/contract'
import {
  deriveStoredDecisionObservations,
  foldDecisions,
  loadVerifiedDecisionRecords,
  loadStoredReviews,
} from '@factory/domain'
import {
  DecisionAuthorityConflictError,
  type DecisionRecordAuthority,
  type RecordRef,
  type RepositoryStore,
  type DecisionActionInput,
} from '@factory/repository'
import { restorePreparedRecord } from '@factory/repository/internal/admission'

export type { DecisionObservationSource } from '@factory/domain'
export type { DecisionActionInput } from '@factory/repository'
export type DecisionActionRef = RecordRef & { actionId: RecordId }

export class StaleDecisionActionError extends Error {
  constructor() {
    super('decision action was based on a stale decision view')
    this.name = 'StaleDecisionActionError'
  }
}

/** Repair a crash after manifest-last review publication but before derived observations append. */
export async function recoverDecisionObservations(store: RepositoryStore): Promise<number> {
  // Restore only derivations from the actual store's validated immutable groups,
  // never caller-supplied records or a fresh interpretation of the live dictionary.
  const stored = await store.readRecords()
  const existing = new Map(
    stored.records
      .filter(record => /^decisions\/observations\/[^/]+\.json$/.test(record.path))
      .map(record => [
        (record.value as unknown as DecisionObservation).observationId,
        record.value,
      ]),
  )
  const observations = deriveStoredDecisionObservations(stored).filter(observation => {
    const prior = existing.get(observation.observationId)
    if (prior === undefined) return true
    if (canonicalJson(prior) !== canonicalJson(observation))
      throw new TypeError('stored decision differs from its review derivation')
    return false
  })
  if (observations.length === 0) return 0
  const reviewIds = new Set(observations.map(observation => observation.reviewId))
  const checkedObjects = new Set<string>()
  for (const review of loadStoredReviews(stored.records)) {
    if (review.ledger === undefined || !reviewIds.has(review.manifest.reviewId)) continue
    const inventory = [
      ...new Map(
        [
          ...review.ledger.entries.flatMap(entry => entry.evidence),
          ...(review.ledger.summary?.evidence ?? []),
        ].map(citation => [canonicalJson(citation.object), citation.object]),
      ).values(),
    ]
    for (const object of inventory) {
      const identity = canonicalJson(object)
      if (!checkedObjects.has(identity)) {
        await store.getObject(object)
        checkedObjects.add(identity)
      }
    }
    const rebuilt = readAuditDraft(
      Buffer.from(review.submissions),
      inventory,
      review.manifest.reviewId,
    )
    if (
      canonicalJson(rebuilt.entries) !== canonicalJson(review.ledger.entries) ||
      canonicalJson(rebuilt.summary ?? null) !== canonicalJson(review.ledger.summary ?? null)
    )
      throw new TypeError('decision recovery ledger differs from its stored submissions')
  }
  const repositoryRoot = await realpath(store.repositoryRoot)
  for (const observation of observations) {
    await store.createImmutable(
      restorePreparedRecord(
        repositoryRoot,
        makeOwnedPath('decisions', ['observations', `${observation.observationId}.json`]),
        new TextEncoder().encode(canonicalJson(observation)),
      ),
    )
  }
  return observations.length
}

function recordAuthority(
  observations: readonly DecisionObservation[],
  actions: readonly DecisionAction[],
  canonicalBranch: string,
): DecisionRecordAuthority {
  const values: { path: OwnedPath; value: DecisionObservation | DecisionAction }[] = [
    ...observations.map(observation => ({
      path: makeOwnedPath('decisions', ['observations', `${observation.observationId}.json`]),
      value: observation,
    })),
    ...actions.map(action => ({
      path: makeOwnedPath('decisions', ['actions', `${action.actionId}.json`]),
      value: action,
    })),
  ]
  return {
    canonicalBranch,
    records: values.map(record => ({
      path: record.path,
      sha256: createHash('sha256').update(canonicalJson(record.value)).digest('hex'),
    })),
  }
}

/** Validate against the shared fold, then atomically append against exact record authority. */
export async function appendDecisionAction(
  store: RepositoryStore,
  input: DecisionActionInput,
  now: () => Date = () => new Date(),
): Promise<DecisionActionRef> {
  const config = await store.readConfig()
  if (config.canonicalBranch === undefined)
    throw new TypeError('decision actions require a configured canonical branch')
  const canonicalBranch = config.canonicalBranch
  const { observations, actions } = loadVerifiedDecisionRecords(await store.readRecords())
  const existing = actions.find(action => action.actionId === input.actionId)
  if (existing !== undefined) {
    input = await store.prepareDecisionAction(input)
    const { createdAt: _createdAt, previousActionId: _previousActionId, ...semantic } = existing
    if (canonicalJson(semantic) !== canonicalJson(input))
      throw new TypeError('decision action identity already names different semantics')
    const ref = await store.createDecisionAction(
      existing,
      recordAuthority(observations, actions, canonicalBranch),
    )
    return { ...ref, actionId: existing.actionId }
  }
  const current = foldDecisions(observations, actions, canonicalBranch)
  if (input.expectedStateFingerprint !== current.stateFingerprint)
    throw new StaleDecisionActionError()
  input = await store.prepareDecisionAction(input)
  const action = {
    ...input,
    previousActionId: current.actionHeadId ?? null,
    createdAt: now().toISOString(),
  } as DecisionAction
  validatePublicRecord(makeOwnedPath('decisions', ['actions', `${action.actionId}.json`]), action)
  const next = foldDecisions(observations, [...actions, action], canonicalBranch)
  const rejected = next.diagnostics.find(item => item.actionId === action.actionId)
  if (rejected !== undefined) throw new TypeError(rejected.reason)
  let ref: RecordRef
  try {
    ref = await store.createDecisionAction(
      action,
      recordAuthority(observations, actions, canonicalBranch),
    )
  } catch (error) {
    if (error instanceof DecisionAuthorityConflictError) throw new StaleDecisionActionError()
    throw error
  }
  return { ...ref, actionId: action.actionId }
}
