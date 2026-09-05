import { createHash } from 'node:crypto'

import {
  canonicalJson,
  decisionAssertionFingerprint,
  makeOwnedPath,
  newRecordId,
  validatePublicRecord,
  type DecisionAction,
  type DecisionObservation,
  type OwnedPath,
  type PullRequestObservation,
  type RecordId,
  type ReviewLedger,
  type ReviewManifest,
  type RepositoryObservation,
} from '@factory/contract'
import { foldDecisions } from '@factory/domain'
import {
  DecisionAuthorityConflictError,
  type DecisionRecordAuthority,
  type RecordRef,
  type RepositoryRecords,
  type RepositoryStore,
} from '@factory/repository'

import { loadStoredReviews } from './stored-reviews'

export type DecisionObservationSource = DecisionObservation['source']
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

function reviewRoot(manifest: ReviewManifest): readonly string[] {
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

function validateCommittedReview(manifest: ReviewManifest, ledger: ReviewLedger): void {
  const root = reviewRoot(manifest)
  validatePublicRecord(makeOwnedPath('reviews', [...root, 'manifest.json']), manifest)
  validatePublicRecord(makeOwnedPath('reviews', [...root, 'ledger.json']), ledger)
  if (ledger.reviewId !== manifest.reviewId) throw new TypeError('decision ledger review mismatch')
  if (manifest.disposition === 'failed') throw new TypeError('failed review has no decision ledger')
}

/** Classify review source from its exact committed subject; GitHub defaults never participate. */
function decisionObservationSource(
  manifest: ReviewManifest,
  subjectRecord: unknown,
): DecisionObservationSource {
  if (manifest.subject.kind === 'pull-request') {
    const path = makeOwnedPath('pull-requests', [
      manifest.subject.provider,
      manifest.subject.repositoryKey,
      String(manifest.subject.number),
      'observations',
      `${manifest.subject.observationId}.json`,
    ])
    validatePublicRecord(path, subjectRecord)
    const observation = subjectRecord as PullRequestObservation
    if (
      observation.provider !== manifest.subject.provider ||
      observation.repositoryKey !== manifest.subject.repositoryKey ||
      observation.number !== manifest.subject.number ||
      observation.observationId !== manifest.subject.observationId
    )
      throw new TypeError('decision pull-request source differs from its review subject')
    return {
      kind: 'pull-request',
      provider: manifest.subject.provider,
      repositoryKey: manifest.subject.repositoryKey,
      number: manifest.subject.number,
      observationId: manifest.subject.observationId,
    }
  }
  const path = makeOwnedPath('repository-observations', [
    `${manifest.subject.repositoryObservationId}.json`,
  ])
  validatePublicRecord(path, subjectRecord)
  const observation = subjectRecord as RepositoryObservation
  return {
    kind: 'workspace',
    branch: observation.git.branch ?? null,
    exactSnapshot:
      observation.startState === observation.endState &&
      !observation.limitations.some(item => item.code === 'repository-race'),
  }
}

/** Derive stable append-only observations only from already validated decision entries. */
function deriveDecisionObservations(
  manifest: ReviewManifest,
  ledger: ReviewLedger,
  subjectRecord: unknown,
): readonly DecisionObservation[] {
  validateCommittedReview(manifest, ledger)
  const source = decisionObservationSource(manifest, subjectRecord)
  return ledger.entries
    .filter(entry => entry.kind === 'decision')
    .map(entry => {
      const digest = createHash('sha256')
        .update(manifest.reviewId)
        .update('\0')
        .update(canonicalJson(manifest.subject))
        .update('\0')
        .update(entry.entryId)
        .digest()
      const observation: DecisionObservation = {
        schemaVersion: 1,
        observationId: newRecordId(
          'decision',
          Date.parse(manifest.completedAt),
          digest.subarray(0, 10),
        ),
        reviewId: manifest.reviewId,
        reviewEntryId: entry.entryId,
        decisionKey: entry.decisionKey,
        effect: entry.effect,
        assertion: entry.assertion,
        assertionFingerprint: decisionAssertionFingerprint(entry),
        summary: entry.summary,
        source,
        confidence: entry.confidence,
        observedAt: manifest.completedAt,
      }
      validatePublicRecord(
        makeOwnedPath('decisions', ['observations', `${observation.observationId}.json`]),
        observation,
      )
      return observation
    })
    .sort((left, right) => left.observationId.localeCompare(right.observationId))
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

function subjectRecordForStoredReview(
  manifest: ReviewManifest,
  records: RepositoryRecords,
): unknown {
  const path =
    manifest.subject.kind === 'pull-request'
      ? makeOwnedPath('pull-requests', [
          manifest.subject.provider,
          manifest.subject.repositoryKey,
          String(manifest.subject.number),
          'observations',
          `${manifest.subject.observationId}.json`,
        ])
      : makeOwnedPath('repository-observations', [
          `${manifest.subject.repositoryObservationId}.json`,
        ])
  const value = records.records.find(record => record.path === path)?.value
  if (value === undefined) throw new TypeError('decision review subject record is absent')
  return value
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
  for (const review of loadStoredReviews(records.records)) {
    if (review.ledger === undefined) continue
    const subjectRecord = subjectRecordForStoredReview(review.manifest, records)
    for (const observation of deriveDecisionObservations(
      review.manifest,
      review.ledger,
      subjectRecord,
    )) {
      await store.createImmutable(
        makeOwnedPath('decisions', ['observations', `${observation.observationId}.json`]),
        new TextEncoder().encode(canonicalJson(observation)),
      )
      if (!existing.has(observation.observationId)) {
        existing.add(observation.observationId)
        created += 1
      }
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

function decisionRecords(records: RepositoryRecords): {
  observations: DecisionObservation[]
  actions: DecisionAction[]
} {
  const observations: DecisionObservation[] = []
  const actions: DecisionAction[] = []
  for (const record of records.records) {
    if (/^decisions\/observations\/[^/]+\.json$/.test(record.path))
      observations.push(record.value as DecisionObservation)
    if (/^decisions\/actions\/[^/]+\.json$/.test(record.path))
      actions.push(record.value as DecisionAction)
  }
  const expected = new Map<RecordId, DecisionObservation>()
  for (const review of loadStoredReviews(records.records)) {
    if (review.ledger === undefined) continue
    const subjectRecord = subjectRecordForStoredReview(review.manifest, records)
    for (const observation of deriveDecisionObservations(
      review.manifest,
      review.ledger,
      subjectRecord,
    )) {
      const prior = expected.get(observation.observationId)
      if (prior !== undefined && canonicalJson(prior) !== canonicalJson(observation))
        throw new TypeError('accepted reviews derive conflicting decision observations')
      expected.set(observation.observationId, observation)
    }
  }
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
  const { observations, actions } = decisionRecords(records)
  return foldDecisions(observations, actions, canonicalBranch)
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
  const { observations, actions } = decisionRecords(await store.readRecords())
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
