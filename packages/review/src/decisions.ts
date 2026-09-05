import { createHash } from 'node:crypto'

import {
  canonicalJson,
  makeOwnedPath,
  validatePublicRecord,
  type DecisionAction,
  type DecisionObservation,
  type OwnedPath,
  type RecordId,
  type ReviewLedger,
  type ReviewManifest,
} from '@factory/contract'
import {
  deriveDecisionObservations,
  deriveStoredDecisionObservations,
  foldDecisions,
  loadVerifiedDecisionRecords,
} from '@factory/domain'
import {
  DecisionAuthorityConflictError,
  type DecisionRecordAuthority,
  type RecordRef,
  type RepositoryRecords,
  type RepositoryStore,
} from '@factory/repository'

export type { DecisionObservationSource } from '@factory/domain'
export type DecisionActionInput = DecisionAction extends infer Action
  ? Action extends DecisionAction
    ? Omit<Action, 'createdAt' | 'previousActionId'>
    : never
  : never
export type DecisionActionRef = RecordRef & { actionId: RecordId }

export class StaleDecisionActionError extends Error {
  constructor() {
    super('decision action was based on a stale decision view')
    this.name = 'StaleDecisionActionError'
  }
}

/** Recoverably publish all observations; deterministic IDs make interrupted retries converge. */
export async function appendDecisionObservations(
  store: RepositoryStore,
  manifest: ReviewManifest,
  ledger: ReviewLedger,
  subjectRecord: unknown,
): Promise<readonly RecordRef[]> {
  const observations = deriveDecisionObservations(manifest, ledger, subjectRecord)
  const refs: RecordRef[] = []
  for (const observation of observations) {
    refs.push(
      await store.createImmutable(
        makeOwnedPath('decisions', ['observations', `${observation.observationId}.json`]),
        new TextEncoder().encode(canonicalJson(observation)),
      ),
    )
  }
  return refs
}

/** Repair a crash after manifest-last review publication but before derived observations append. */
export async function recoverDecisionObservations(
  store: RepositoryStore,
  records: RepositoryRecords,
): Promise<number> {
  const existing = new Set(
    records.records
      .filter(record => /^decisions\/observations\/[^/]+\.json$/.test(record.path))
      .map(record => (record.value as DecisionObservation).observationId),
  )
  let created = 0
  for (const observation of deriveStoredDecisionObservations(records)) {
    await store.createImmutable(
      makeOwnedPath('decisions', ['observations', `${observation.observationId}.json`]),
      new TextEncoder().encode(canonicalJson(observation)),
    )
    if (!existing.has(observation.observationId)) {
      existing.add(observation.observationId)
      created += 1
    }
  }
  return created
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
