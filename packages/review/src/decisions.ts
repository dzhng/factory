import {
  canonicalJson,
  makeOwnedPath,
  validatePublicRecord,
  type DecisionAction,
  type RecordId,
} from '@factory/contract'
import { foldDecisions, loadDecisionHistory } from '@factory/domain'
import {
  DecisionAuthorityConflictError,
  decisionRecordAuthority,
  type RecordRef,
  type RepositoryStore,
  type DecisionActionInput,
} from '@factory/repository'

export type { DecisionObservationSource } from '@factory/domain'
export type { DecisionActionInput } from '@factory/repository'
export type DecisionActionRef = RecordRef & { actionId: RecordId }

export class StaleDecisionActionError extends Error {
  constructor() {
    super('decision action was based on a stale decision view')
    this.name = 'StaleDecisionActionError'
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
  const records = await store.readRecords()
  const { observations, actions } = loadDecisionHistory(records)
  const authority = decisionRecordAuthority(records, canonicalBranch)
  const existing = actions.find(action => action.actionId === input.actionId)
  if (existing !== undefined) {
    input = await store.prepareDecisionAction(input)
    const { createdAt: _createdAt, previousActionId: _previousActionId, ...semantic } = existing
    if (canonicalJson(semantic) !== canonicalJson(input))
      throw new TypeError('decision action identity already names different semantics')
    const ref = await store.createDecisionAction(existing, authority)
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
    ref = await store.createDecisionAction(action, authority)
  } catch (error) {
    if (error instanceof DecisionAuthorityConflictError) throw new StaleDecisionActionError()
    throw error
  }
  return { ...ref, actionId: action.actionId }
}
