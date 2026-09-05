import { createHash } from 'node:crypto'

import {
  canonicalJson,
  decisionAssertionFingerprint,
  makeOwnedPath,
  newRecordId,
  validatePublicRecord,
  type DecisionAction,
  type DecisionObservation,
  type PullRequestObservation,
  type RecordId,
  type RepositoryObservation,
  type ReviewLedger,
  type ReviewManifest,
  type Sha256,
} from '@factory/contract'

export type DecisionObservationSource = DecisionObservation['source']

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

function observationSource(
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

/** Reproduce decision observations exactly from one accepted review and its pinned subject. */
export function deriveDecisionObservations(
  manifest: ReviewManifest,
  ledger: ReviewLedger,
  subjectRecord: unknown,
): readonly DecisionObservation[] {
  validateCommittedReview(manifest, ledger)
  const source = observationSource(manifest, subjectRecord)
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

export type DecisionLifecycle =
  | 'invalid'
  | 'proposal'
  | 'canonical-current'
  | 'canonical-replay'
  | 'pending-supersession'
  | 'superseded'
  | 'removed'
  | 'rejected'

export type DecisionHumanStatus = 'unconfirmed' | 'confirmed' | 'disputed'

export type DecisionObservationView = {
  observation: DecisionObservation
  scope: 'proposal' | 'canonical'
  lifecycle: DecisionLifecycle
  humanStatus: DecisionHumanStatus
  materiality: 'new' | 'unchanged' | 'material-change' | 'removal' | 'contradiction'
  priority: 'normal' | 'high'
  pendingReason?: 'change' | 'removal' | 'contradiction'
  pendingFromObservationId?: RecordId
}

export type DecisionLineageView = {
  decisionKey: string
  currentObservationId?: RecordId
  observations: readonly DecisionObservationView[]
}

export type DecisionDiagnostic = {
  kind: 'invalid-observation' | 'stale-action'
  priority: 'high'
  observationId?: RecordId
  actionId?: RecordId
  reason: string
}

export type DecisionView = {
  canonicalBranch: string
  actionHeadId?: RecordId
  stateFingerprint: Sha256
  lineages: readonly DecisionLineageView[]
  diagnostics: readonly DecisionDiagnostic[]
}

type MutableObservationView = {
  observation: DecisionObservation
  scope: 'proposal' | 'canonical'
  lifecycle: DecisionLifecycle
  humanStatus: DecisionHumanStatus
  materiality: DecisionObservationView['materiality']
  priority: 'normal' | 'high'
  pendingReason?: 'change' | 'removal' | 'contradiction'
  pendingFromObservationId?: RecordId
}

type MutableLineage = {
  decisionKey: string
  currentObservationId?: RecordId
  observations: MutableObservationView[]
}

function chronological(
  left: { observedAt: string; observationId: string },
  right: { observedAt: string; observationId: string },
): number {
  return (
    Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
    left.observationId.localeCompare(right.observationId)
  )
}

function isCanonical(observation: DecisionObservation, canonicalBranch: string): boolean {
  return (
    observation.source.kind === 'workspace' &&
    observation.source.exactSnapshot &&
    observation.source.branch === canonicalBranch
  )
}

function reasonFor(observation: DecisionObservation): 'change' | 'removal' | 'contradiction' {
  if (observation.effect === 'remove') return 'removal'
  if (observation.effect === 'contradict') return 'contradiction'
  return 'change'
}

function materialityFor(
  observation: DecisionObservation,
): 'material-change' | 'removal' | 'contradiction' {
  const reason = reasonFor(observation)
  return reason === 'change' ? 'material-change' : reason
}

function diagnostic(
  diagnostics: DecisionDiagnostic[],
  action: DecisionAction,
  reason: string,
): void {
  diagnostics.push({ kind: 'stale-action', priority: 'high', actionId: action.actionId, reason })
}

function immutableView(
  canonicalBranch: string,
  lineages: Iterable<MutableLineage>,
  diagnostics: DecisionDiagnostic[],
  observations: readonly DecisionObservation[],
  actions: readonly DecisionAction[],
  actionHeadId: RecordId | undefined,
): DecisionView {
  const stableLineages = [...lineages]
    .sort((left, right) => left.decisionKey.localeCompare(right.decisionKey))
    .map(lineage => ({
      decisionKey: lineage.decisionKey,
      ...(lineage.currentObservationId === undefined
        ? {}
        : { currentObservationId: lineage.currentObservationId }),
      observations: lineage.observations
        .sort((left, right) => chronological(left.observation, right.observation))
        .map(item => ({ ...item })),
    }))
  const stableDiagnostics = [...diagnostics].sort(
    (left, right) =>
      (left.actionId ?? left.observationId ?? '').localeCompare(
        right.actionId ?? right.observationId ?? '',
      ) || left.reason.localeCompare(right.reason),
  )
  const semantic = {
    canonicalBranch,
    ...(actionHeadId === undefined ? {} : { actionHeadId }),
    lineages: stableLineages,
    diagnostics: stableDiagnostics,
  }
  const history = {
    observations: [...observations].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
    actions: [...actions].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
  }
  return {
    ...semantic,
    stateFingerprint: createHash('sha256')
      .update(canonicalJson({ ...semantic, history }))
      .digest('hex'),
  }
}

/**
 * Fold explicit decision identities and actions without depending on record enumeration order.
 * Prose is presentation only: material equality is the validated assertion fingerprint.
 */
export function foldDecisions(
  observations: readonly DecisionObservation[],
  actions: readonly DecisionAction[],
  canonicalBranch: string,
): DecisionView {
  if (canonicalBranch.trim().length === 0) throw new TypeError('canonicalBranch must be nonblank')
  observations.forEach(observation =>
    validatePublicRecord(
      makeOwnedPath('decisions', ['observations', `${observation.observationId}.json`]),
      observation,
    ),
  )
  actions.forEach(action =>
    validatePublicRecord(
      makeOwnedPath('decisions', ['actions', `${action.actionId}.json`]),
      action,
    ),
  )
  const lineages = new Map<string, MutableLineage>()
  const byObservation = new Map<RecordId, MutableObservationView>()
  const diagnostics: DecisionDiagnostic[] = []
  const disputes = new Map<
    RecordId,
    {
      target: MutableObservationView
      prior: DecisionHumanStatus
      active: boolean
    }
  >()

  const observe = (observation: DecisionObservation): void => {
    if (byObservation.has(observation.observationId)) {
      diagnostics.push({
        kind: 'invalid-observation',
        priority: 'high',
        observationId: observation.observationId,
        reason: 'duplicate observation identity',
      })
      return
    }
    let lineage = lineages.get(observation.decisionKey)
    if (lineage === undefined) {
      lineage = { decisionKey: observation.decisionKey, observations: [] }
      lineages.set(observation.decisionKey, lineage)
    }
    const canonical = isCanonical(observation, canonicalBranch)
    let item: MutableObservationView
    if (!canonical) {
      item = {
        observation,
        scope: 'proposal',
        lifecycle: 'proposal',
        humanStatus: 'unconfirmed',
        materiality: 'new',
        priority: 'normal',
      }
    } else if (lineage.currentObservationId === undefined) {
      if (observation.effect === 'assert') {
        item = {
          observation,
          scope: 'canonical',
          lifecycle: 'canonical-current',
          humanStatus: 'unconfirmed',
          materiality: 'new',
          priority: 'normal',
        }
        lineage.currentObservationId = observation.observationId
      } else {
        item = {
          observation,
          scope: 'canonical',
          lifecycle: 'invalid',
          humanStatus: 'unconfirmed',
          materiality: materialityFor(observation),
          priority: 'high',
        }
        diagnostics.push({
          kind: 'invalid-observation',
          priority: 'high',
          observationId: observation.observationId,
          reason: `${observation.effect} has no canonical observation to supersede`,
        })
      }
    } else {
      const current = byObservation.get(lineage.currentObservationId)!
      if (observation.assertionFingerprint === current.observation.assertionFingerprint) {
        item = {
          observation,
          scope: 'canonical',
          lifecycle: 'canonical-replay',
          humanStatus: 'unconfirmed',
          materiality: 'unchanged',
          priority: 'normal',
        }
      } else {
        item = {
          observation,
          scope: 'canonical',
          lifecycle: 'pending-supersession',
          humanStatus: 'unconfirmed',
          materiality: materialityFor(observation),
          priority: 'high',
          pendingReason: reasonFor(observation),
          pendingFromObservationId: current.observation.observationId,
        }
      }
    }
    lineage.observations.push(item)
    byObservation.set(observation.observationId, item)
  }

  const act = (action: DecisionAction): void => {
    if (action.actor.kind !== 'human') {
      diagnostic(diagnostics, action, 'review actors cannot apply decision actions')
      return
    }
    if (action.kind === 'resolve') {
      const dispute = disputes.get(action.disputeActionId)
      if (dispute === undefined || !dispute.active) {
        diagnostic(diagnostics, action, 'resolve target is not an active dispute')
        return
      }
      dispute.target.humanStatus = dispute.prior
      dispute.target.priority =
        dispute.target.lifecycle === 'pending-supersession' ? 'high' : 'normal'
      dispute.active = false
      return
    }

    if (action.kind === 'supersede') {
      const from = byObservation.get(action.fromObservationId)
      const to = byObservation.get(action.toObservationId)
      const lineage = from === undefined ? undefined : lineages.get(from.observation.decisionKey)
      if (
        from === undefined ||
        to === undefined ||
        lineage === undefined ||
        from.observation.decisionKey !== to.observation.decisionKey ||
        lineage.currentObservationId !== from.observation.observationId ||
        to.lifecycle !== 'pending-supersession' ||
        to.pendingFromObservationId !== from.observation.observationId ||
        Date.parse(action.createdAt) < Date.parse(from.observation.observedAt) ||
        Date.parse(action.createdAt) < Date.parse(to.observation.observedAt)
      ) {
        diagnostic(diagnostics, action, 'supersede targets are no longer the current transition')
        return
      }
      from.lifecycle = 'superseded'
      from.priority = from.humanStatus === 'disputed' ? 'high' : 'normal'
      to.lifecycle = to.observation.effect === 'remove' ? 'removed' : 'canonical-current'
      to.priority = to.humanStatus === 'disputed' ? 'high' : 'normal'
      delete to.pendingReason
      delete to.pendingFromObservationId
      lineage.currentObservationId = to.observation.observationId
      for (const candidate of lineage.observations) {
        if (
          candidate === to ||
          candidate.lifecycle !== 'pending-supersession' ||
          candidate.pendingFromObservationId !== from.observation.observationId
        )
          continue
        if (candidate.observation.assertionFingerprint === to.observation.assertionFingerprint) {
          candidate.lifecycle = 'canonical-replay'
          candidate.humanStatus = to.humanStatus
          candidate.materiality = 'unchanged'
          candidate.priority = to.humanStatus === 'disputed' ? 'high' : 'normal'
          delete candidate.pendingReason
          delete candidate.pendingFromObservationId
        } else candidate.pendingFromObservationId = to.observation.observationId
      }
      return
    }

    const target = byObservation.get(action.targetObservationId)
    const targetLineage =
      target === undefined ? undefined : lineages.get(target.observation.decisionKey)
    const currentTarget =
      targetLineage?.currentObservationId === undefined
        ? undefined
        : byObservation.get(targetLineage.currentObservationId)
    if (
      target === undefined ||
      ['invalid', 'rejected', 'superseded'].includes(target.lifecycle) ||
      (target.lifecycle === 'canonical-replay' &&
        currentTarget?.observation.assertionFingerprint !==
          target.observation.assertionFingerprint) ||
      Date.parse(action.createdAt) < Date.parse(target.observation.observedAt)
    ) {
      diagnostic(diagnostics, action, 'action target is absent or terminal')
      return
    }
    if (action.kind === 'confirm') {
      if (target.humanStatus === 'confirmed') {
        diagnostic(diagnostics, action, 'decision is already confirmed')
        return
      }
      target.humanStatus = 'confirmed'
      return
    }
    if (action.kind === 'reject') {
      if (!['proposal', 'pending-supersession'].includes(target.lifecycle)) {
        diagnostic(diagnostics, action, 'only a proposal or pending supersession can be rejected')
        return
      }
      target.lifecycle = 'rejected'
      target.priority = 'normal'
      delete target.pendingReason
      delete target.pendingFromObservationId
      return
    }
    if (target.humanStatus === 'disputed') {
      diagnostic(diagnostics, action, 'decision already has an active dispute')
      return
    }
    disputes.set(action.actionId, {
      target,
      prior: target.humanStatus,
      active: true,
    })
    target.humanStatus = 'disputed'
    target.priority = 'high'
  }

  const events = [
    ...observations.map(observation => ({
      kind: 'observation' as const,
      order: 0,
      at: observation.observedAt,
      id: observation.observationId,
      observation,
    })),
    ...actions.map(action => ({
      kind: 'action' as const,
      order: 1,
      at: action.createdAt,
      id: action.actionId,
      action,
    })),
  ].sort(
    (left, right) =>
      Date.parse(left.at) - Date.parse(right.at) ||
      left.order - right.order ||
      left.id.localeCompare(right.id),
  )
  const actionIds = new Set<RecordId>()
  let actionHeadId: RecordId | undefined
  for (const event of events) {
    if (event.kind === 'observation') observe(event.observation)
    else if (actionIds.has(event.action.actionId))
      diagnostic(diagnostics, event.action, 'duplicate action identity')
    else {
      actionIds.add(event.action.actionId)
      if (event.action.previousActionId !== (actionHeadId ?? null)) {
        diagnostic(diagnostics, event.action, 'action was based on a different action head')
        continue
      }
      const diagnosticCount = diagnostics.length
      act(event.action)
      if (diagnostics.length === diagnosticCount) actionHeadId = event.action.actionId
    }
  }

  return immutableView(
    canonicalBranch,
    lineages.values(),
    diagnostics,
    observations,
    actions,
    actionHeadId,
  )
}
