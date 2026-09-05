import { createHash } from 'node:crypto'

import {
  canonicalJson,
  type AssociationBatch,
  type CoverageAction,
  type DecisionAction,
  type DecisionObservation,
  type LifecycleRecord,
  type PullRequestObservation,
  type RepositoryObservation,
  type RepositoryRecords,
  type ReviewLedger,
  type ReviewManifest,
  type ReviewTrigger,
  type SessionIdentity,
  type SessionPullRequestAssociation,
  type TurnManifest,
} from '@factory/contract'

import { foldDecisions, type DecisionView } from './decisions'

export type UiLimitation = { code: string; detail: string }

export type UiTurn = {
  turnId: string
  capturedAt: string
  branch: string | null
  repositoryObservationId: string | null
  evidenceWatermark: number
  eventCount: number
  transcriptCount: number
  limitations: readonly UiLimitation[]
}

export type UiSession = {
  sessionKey: string
  provider: 'codex' | 'claude'
  nativeSessionId: string
  firstObservedAt: string
  active: boolean
  turns: readonly UiTurn[]
}

export type UiPullRequest = {
  repositoryKey: string
  number: number
  observationId: string
  observedAt: string
  availability: PullRequestObservation['availability']
  completeness: 'complete' | 'partial' | 'unavailable'
  state: 'open' | 'closed' | 'merged' | 'unavailable'
  url?: string
  limitations: readonly UiLimitation[]
}

export type UiAssociation = {
  evidenceId: string
  sessionKey: string
  pullRequestObservationId: string
  kind: SessionPullRequestAssociation['kind']
  authority: 'exact' | 'asserted' | 'invalidation'
  repositoryIdentity: SessionPullRequestAssociation['repositoryIdentity']
  shas: readonly string[]
  observedAt: string
}

export type UiTrigger = {
  triggerId: string
  sessionKey: string
  turnId: string
  provider: ReviewTrigger['provider']
  evidenceWatermark: number
  materialization: ReviewTrigger['materialization']
  coverage: 'pending' | 'reviewed' | 'partial' | 'accepted-partial'
  limitations: readonly UiLimitation[]
}

export type UiReview = {
  reviewId: string
  subject: ReviewManifest['subject']
  completedAt: string
  disposition: ReviewManifest['disposition']
  coverageEffect: ReviewManifest['subjectAttempt']['effect']
  coverageAccepted: boolean
  failureReason?: string
  limitations: readonly UiLimitation[]
  findings: readonly { entryId: string; severity: string; summary: string }[]
  decisions: readonly { entryId: string; decisionKey: string; effect: string; summary: string }[]
  responsePreview: string
  responseTruncated: boolean
}

export type UiRepositoryObservation = {
  observationId: string
  observedAt: string
  branch: string | null
  detached: boolean
  head: string | null
  changedPaths: number
  exact: boolean
  limitations: readonly UiLimitation[]
}

export type UiReadySnapshot = {
  schemaVersion: 1
  state: 'ready'
  canonicalBranch: string | null
  counts: {
    sessions: number
    turns: number
    pullRequests: number
    reviews: number
    pendingTriggers: number
    highPriorityDecisions: number
  }
  sessions: readonly UiSession[]
  repositoryObservations: readonly UiRepositoryObservation[]
  pullRequests: readonly UiPullRequest[]
  associations: readonly UiAssociation[]
  triggers: readonly UiTrigger[]
  reviews: readonly UiReview[]
  decisions: DecisionView | null
  diagnostics: readonly { priority: 'normal' | 'high'; message: string }[]
}

export type UiUnavailableSnapshot = {
  schemaVersion: 1
  state: 'corrupt' | 'upgrade-required'
  title: string
  message: string
}

export type UiSnapshot = UiReadySnapshot | UiUnavailableSnapshot

const textEncoder = new TextEncoder()
const MAX_RESPONSE_PREVIEW_BYTES = 16 * 1024

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function limitText(value: string): { value: string; truncated: boolean } {
  const bytes = textEncoder.encode(value)
  if (bytes.byteLength <= MAX_RESPONSE_PREVIEW_BYTES) return { value, truncated: false }
  const prefix = bytes.subarray(0, MAX_RESPONSE_PREVIEW_BYTES)
  return {
    value: new TextDecoder('utf-8', { fatal: false }).decode(prefix).replace(/\uFFFD$/u, ''),
    truncated: true,
  }
}

function limitations(value: { limitations: readonly UiLimitation[] }): readonly UiLimitation[] {
  return [...value.limitations].sort(
    (left, right) => left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail),
  )
}

function recordMap(records: RepositoryRecords): Map<string, unknown[]> {
  const values = new Map<string, unknown[]>()
  for (const record of records.records) {
    const existing = values.get(record.path)
    if (existing === undefined) values.set(record.path, [record.value])
    else existing.push(record.value)
  }
  return values
}

function completedAssociations(records: RepositoryRecords): UiAssociation[] {
  const observations = new Map<string, PullRequestObservation>()
  const associations = new Map<string, SessionPullRequestAssociation>()
  const batches: AssociationBatch[] = []
  for (const record of records.records) {
    if (/^pull-requests\/github\/[^/]+\/[1-9]\d*\/observations\/[^/]+\.json$/.test(record.path))
      observations.set(
        (record.value as unknown as PullRequestObservation).observationId,
        record.value as unknown as PullRequestObservation,
      )
    else if (
      /^pull-requests\/github\/[^/]+\/[1-9]\d*\/associations\/[^/]+\/batches\/[^/]+\.json$/.test(
        record.path,
      )
    )
      batches.push(record.value as unknown as AssociationBatch)
    else if (
      /^pull-requests\/github\/[^/]+\/[1-9]\d*\/associations\/[^/]+\/[^/]+\.json$/.test(record.path)
    )
      associations.set(
        (record.value as unknown as SessionPullRequestAssociation).evidenceId,
        record.value as unknown as SessionPullRequestAssociation,
      )
  }
  const visible = new Map<string, SessionPullRequestAssociation>()
  for (const batch of batches) {
    const observation = observations.get(batch.pullRequestObservationId)
    const evidence = batch.evidence
      .map(item => associations.get(item.evidenceId))
      .filter((item): item is SessionPullRequestAssociation => item !== undefined)
    if (observation === undefined || evidence.length !== batch.evidence.length) continue
    if (batch.evidence.some(item => hash(associations.get(item.evidenceId)) !== item.sha256))
      continue
    if (
      evidence.some(
        item =>
          item.pullRequestObservationId !== observation.observationId ||
          item.observedAt !== batch.observedAt,
      )
    )
      continue
    evidence.forEach(item => visible.set(item.evidenceId, item))
  }
  return [...visible.values()]
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .map(item => ({
      evidenceId: item.evidenceId,
      sessionKey: item.sessionKey,
      pullRequestObservationId: item.pullRequestObservationId,
      kind: item.kind,
      authority:
        item.kind === 'manual'
          ? 'asserted'
          : item.kind === 'invalidation'
            ? 'invalidation'
            : 'exact',
      repositoryIdentity: item.repositoryIdentity,
      shas: item.shas,
      observedAt: item.observedAt,
    }))
}

function reviewGroups(
  records: RepositoryRecords,
): { manifest: ReviewManifest; ledger?: ReviewLedger; response: string }[] {
  const map = recordMap(records)
  const groups: { manifest: ReviewManifest; ledger?: ReviewLedger; response: string }[] = []
  for (const record of records.records) {
    if (
      !/^reviews\/(?:workspace|pull-requests\/github\/[^/]+\/[1-9]\d*)\/[^/]+\/manifest\.json$/.test(
        record.path,
      )
    )
      continue
    const root = record.path.slice(0, -'/manifest.json'.length)
    const manifest = record.value as unknown as ReviewManifest
    const response = map.get(`${root}/response.txt`)?.[0]
    const ledger = map.get(`${root}/ledger.json`)?.[0]
    if (typeof response !== 'string') continue
    if (manifest.disposition !== 'failed' && ledger === undefined) continue
    groups.push({
      manifest,
      ...(ledger === undefined ? {} : { ledger: ledger as ReviewLedger }),
      response,
    })
  }
  return groups.sort((left, right) => left.manifest.reviewId.localeCompare(right.manifest.reviewId))
}

/** Rebuild the complete presentation-safe UI state exclusively from validated portable records. */
export function buildUiProjection(input: RepositoryRecords): UiSnapshot {
  const identities = new Map<string, SessionIdentity>()
  const turns = new Map<string, TurnManifest[]>()
  const lifecycle = new Map<string, LifecycleRecord[]>()
  const repositoryObservations: RepositoryObservation[] = []
  const pullRequestObservations: PullRequestObservation[] = []
  const triggers: ReviewTrigger[] = []
  const decisionObservations: DecisionObservation[] = []
  const decisionActions: DecisionAction[] = []
  const coverageActions: CoverageAction[] = []
  const lineCounts = new Map<string, number>()
  for (const record of input.records) {
    lineCounts.set(record.path, (lineCounts.get(record.path) ?? 0) + 1)
    if (/^sessions\/(codex|claude)\/[^/]+\/identity\.json$/.test(record.path)) {
      const identity = record.value as unknown as SessionIdentity
      identities.set(identity.sessionKey, identity)
    } else if (
      /^sessions\/(codex|claude)\/[^/]+\/turns\/[^/]+\/manifest\.json$/.test(record.path)
    ) {
      const turn = record.value as unknown as TurnManifest
      turns.set(turn.sessionKey, [...(turns.get(turn.sessionKey) ?? []), turn])
    } else if (/^sessions\/(codex|claude)\/[^/]+\/lifecycle\/[^/]+\.json$/.test(record.path)) {
      const event = record.value as unknown as LifecycleRecord
      lifecycle.set(event.sessionKey, [...(lifecycle.get(event.sessionKey) ?? []), event])
    } else if (/^repository-observations\/[^/]+\.json$/.test(record.path))
      repositoryObservations.push(record.value as unknown as RepositoryObservation)
    else if (
      /^pull-requests\/github\/[^/]+\/[1-9]\d*\/observations\/[^/]+\.json$/.test(record.path)
    )
      pullRequestObservations.push(record.value as unknown as PullRequestObservation)
    else if (/^review-triggers\/[^/]+\.json$/.test(record.path))
      triggers.push(record.value as unknown as ReviewTrigger)
    else if (/^decisions\/observations\/[^/]+\.json$/.test(record.path))
      decisionObservations.push(record.value as unknown as DecisionObservation)
    else if (/^decisions\/actions\/[^/]+\.json$/.test(record.path))
      decisionActions.push(record.value as unknown as DecisionAction)
    else if (/^reviews\/coverage-actions\/[^/]+\.json$/.test(record.path))
      coverageActions.push(record.value as unknown as CoverageAction)
  }

  const reviews = reviewGroups(input)
  const acceptedReviews = new Set(coverageActions.map(action => action.reviewId))
  const triggerCoverage = new Map<string, UiTrigger['coverage']>()
  for (const review of reviews) {
    for (const selection of review.manifest.evidenceSelections) {
      const coverage: UiTrigger['coverage'] = acceptedReviews.has(review.manifest.reviewId)
        ? 'accepted-partial'
        : review.manifest.disposition === 'partial'
          ? 'partial'
          : review.manifest.disposition === 'complete'
            ? 'reviewed'
            : 'pending'
      const prior = triggerCoverage.get(selection.triggerId)
      const rank = { pending: 0, partial: 1, 'accepted-partial': 2, reviewed: 3 }
      if (prior === undefined || rank[coverage] > rank[prior])
        triggerCoverage.set(selection.triggerId, coverage)
    }
  }

  const sessions = [...identities.values()]
    .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey))
    .map(identity => {
      const sessionTurns = [...(turns.get(identity.sessionKey) ?? [])].sort((left, right) =>
        left.turnId.localeCompare(right.turnId),
      )
      const events = lifecycle.get(identity.sessionKey) ?? []
      return {
        sessionKey: identity.sessionKey,
        provider: identity.provider,
        nativeSessionId: identity.nativeSessionId,
        firstObservedAt: identity.firstObservedAt,
        active: !events.some(event =>
          /(?:sessionend|session-end|stop)$/i.test(event.providerEvent),
        ),
        turns: sessionTurns.map(turn => {
          const root = `sessions/${identity.provider}/${identity.sessionKey}/turns/${turn.turnId}`
          return {
            turnId: turn.turnId,
            capturedAt: turn.capturedAt,
            branch: turn.branch ?? null,
            repositoryObservationId: turn.repositoryObservationId ?? null,
            evidenceWatermark: turn.eventRange.last,
            eventCount: lineCounts.get(`${root}/events.jsonl`) ?? 0,
            transcriptCount: lineCounts.get(`${root}/transcript.jsonl`) ?? 0,
            limitations: limitations(turn),
          }
        }),
      }
    })

  const decisions =
    input.config.canonicalBranch === undefined
      ? null
      : foldDecisions(decisionObservations, decisionActions, input.config.canonicalBranch)
  const diagnostics: { priority: 'normal' | 'high'; message: string }[] = []
  if (input.config.canonicalBranch === undefined)
    diagnostics.push({
      priority: 'high',
      message: 'Canonical branch is not configured; decision scope is unavailable.',
    })
  for (const item of decisions?.diagnostics ?? [])
    diagnostics.push({ priority: item.priority, message: item.reason })
  const highPriorityDecisions =
    decisions?.lineages
      .flatMap(lineage => lineage.observations)
      .filter(item => item.priority === 'high').length ?? 0

  return {
    schemaVersion: 1,
    state: 'ready',
    canonicalBranch: input.config.canonicalBranch ?? null,
    counts: {
      sessions: sessions.length,
      turns: sessions.reduce((sum, session) => sum + session.turns.length, 0),
      pullRequests: new Set(
        pullRequestObservations.map(item => `${item.repositoryKey}:${item.number}`),
      ).size,
      reviews: reviews.length,
      pendingTriggers: triggers.filter(
        trigger => (triggerCoverage.get(trigger.triggerId) ?? 'pending') === 'pending',
      ).length,
      highPriorityDecisions,
    },
    sessions,
    repositoryObservations: repositoryObservations
      .sort((left, right) => left.observationId.localeCompare(right.observationId))
      .map(item => ({
        observationId: item.observationId,
        observedAt: item.observedAt,
        branch: item.git.branch ?? null,
        detached: item.git.detached,
        head: item.git.head ?? null,
        changedPaths: item.changedPaths.length,
        exact:
          item.startState === item.endState &&
          !item.limitations.some(limitation => limitation.code === 'repository-race'),
        limitations: limitations(item),
      })),
    pullRequests: pullRequestObservations
      .sort((left, right) => left.observationId.localeCompare(right.observationId))
      .map(item => ({
        repositoryKey: item.repositoryKey,
        number: item.number,
        observationId: item.observationId,
        observedAt: item.observedAt,
        availability: item.availability,
        completeness: item.availability === 'unavailable' ? 'unavailable' : item.completeness,
        state: item.availability === 'unavailable' ? 'unavailable' : item.state,
        ...(item.availability === 'available' ? { url: item.url } : {}),
        limitations: limitations(item),
      })),
    associations: completedAssociations(input),
    triggers: triggers
      .sort((left, right) => left.triggerId.localeCompare(right.triggerId))
      .map(trigger => ({
        triggerId: trigger.triggerId,
        sessionKey: trigger.sessionKey,
        turnId: trigger.turnId,
        provider: trigger.provider,
        evidenceWatermark: trigger.evidenceWatermark,
        materialization: trigger.materialization,
        coverage: triggerCoverage.get(trigger.triggerId) ?? 'pending',
        limitations: limitations(trigger),
      })),
    reviews: reviews.map(review => {
      const preview = limitText(review.response)
      return {
        reviewId: review.manifest.reviewId,
        subject: review.manifest.subject,
        completedAt: review.manifest.completedAt,
        disposition: review.manifest.disposition,
        coverageEffect: review.manifest.subjectAttempt.effect,
        coverageAccepted: acceptedReviews.has(review.manifest.reviewId),
        ...(review.manifest.failureReason === undefined
          ? {}
          : { failureReason: review.manifest.failureReason }),
        limitations: limitations(review.manifest),
        findings: (review.ledger?.entries ?? [])
          .filter(entry => entry.kind === 'finding')
          .map(entry => ({
            entryId: entry.entryId,
            severity: entry.severity,
            summary: entry.summary,
          })),
        decisions: (review.ledger?.entries ?? [])
          .filter(entry => entry.kind === 'decision')
          .map(entry => ({
            entryId: entry.entryId,
            decisionKey: entry.decisionKey,
            effect: entry.effect,
            summary: entry.summary,
          })),
        responsePreview: preview.value,
        responseTruncated: preview.truncated,
      }
    }),
    decisions,
    diagnostics,
  }
}

/** Produce a path-free read failure view; unavailable repositories never gain action authority. */
export function buildUnavailableUiProjection(
  state: UiUnavailableSnapshot['state'],
): UiUnavailableSnapshot {
  return {
    schemaVersion: 1,
    state,
    title: state === 'upgrade-required' ? 'Factory upgrade required' : 'Factory data is unreadable',
    message:
      state === 'upgrade-required'
        ? 'This repository requires a newer Factory reader. Upgrade Factory before opening it.'
        : 'Factory could not validate this repository evidence. No actions are available until the data is repaired.',
  }
}
