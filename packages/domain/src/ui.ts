import {
  type ChoiceAuditEntry,
  type ChoiceAuditSummary,
  type AssociationBatch,
  type CoverageAction,
  type LifecycleRecord,
  type PullRequestObservation,
  type RecordId,
  type RepositoryObservation,
  type RepositoryRecords,
  type ReviewManifest,
  type ReviewTrigger,
  type SessionIdentity,
  type SessionPullRequestAssociation,
  type TurnManifest,
} from '@factory/contract'

import { verifyAssociationBatch } from './associations'
import { foldCoverage, type PriorCoverageReview } from './coverage'
import { loadVerifiedDecisionRecords } from './decision-records'
import { foldDecisions, type DecisionView } from './decisions'
import { loadStoredReviews, resolveStoredReviewSubject } from './stored-reviews'

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
  choices: readonly ChoiceAuditEntry[]
  summary?: ChoiceAuditSummary
  submissionsPreview: string
  submissionsTruncated: boolean
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
  unresolvedDisputes: readonly { actionId: RecordId; targetObservationId: RecordId }[]
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
    if (!verifyAssociationBatch(batch, observation, evidence)) continue
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

/** Rebuild the complete presentation-safe UI state exclusively from validated portable records. */
export function buildUiProjection(input: RepositoryRecords): UiSnapshot {
  const identities = new Map<string, SessionIdentity>()
  const turns = new Map<string, TurnManifest[]>()
  const lifecycle = new Map<string, LifecycleRecord[]>()
  const repositoryObservations: RepositoryObservation[] = []
  const pullRequestObservations: PullRequestObservation[] = []
  const triggers: ReviewTrigger[] = []
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
    else if (/^reviews\/coverage-actions\/[^/]+\.json$/.test(record.path))
      coverageActions.push(record.value as unknown as CoverageAction)
  }

  const reviews = loadStoredReviews(input.records)
  const { observations: decisionObservations, actions: decisionActions } =
    loadVerifiedDecisionRecords(input)
  const acceptedReviews = new Set(coverageActions.map(action => action.reviewId))
  const triggerCoverage = new Map<string, UiTrigger['coverage']>()
  const reviewsById = new Map(reviews.map(review => [review.manifest.reviewId, review]))
  if (reviewsById.size !== reviews.length)
    throw new TypeError('stored review identity is not unique')
  if (coverageActions.some(action => !reviewsById.has(action.reviewId)))
    throw new TypeError('coverage action names no review')
  const reviewsByLineage = Map.groupBy(reviews, review => review.lineage)
  const coverageActionsByLineage = Map.groupBy(
    coverageActions,
    action => reviewsById.get(action.reviewId)!.lineage,
  )
  const acceptedWatermarks: Record<string, number> = {}
  const settledWatermarks: Record<string, number> = {}
  const reviewedWatermarks = new Map<string, Set<number>>()
  const reviewedTriggerIds = new Set<RecordId>()
  const acceptedPartialTriggerIds = new Set<RecordId>()
  for (const [lineage, lineageReviews] of reviewsByLineage) {
    const priorReviews: PriorCoverageReview[] = lineageReviews.map(review => ({
      reviewId: review.manifest.reviewId,
      subject: review.subject ?? resolveStoredReviewSubject(review.manifest, input),
      subjectFingerprint: review.manifest.subjectFingerprint,
      subjectAttempt: review.manifest.subjectAttempt,
      sessionWatermarks: review.manifest.sessionWatermarks,
      coverageTargetWatermarks: review.manifest.coverageTargetWatermarks,
      selections: review.manifest.evidenceSelections,
      inputProblems: review.manifest.inputProblems,
      limitations: review.manifest.limitations,
      triggerIds: review.manifest.triggerIds,
      disposition: review.manifest.disposition,
    }))
    const acceptedActions = coverageActionsByLineage.get(lineage) ?? []
    const coverage = foldCoverage({
      subject: priorReviews[0]!.subject,
      reviews: priorReviews,
      coverageActions: acceptedActions,
    })
    coverage.acceptedTriggerIds.forEach(id => reviewedTriggerIds.add(id))
    for (const [sessionKey, watermark] of Object.entries(coverage.settledWatermarks)) {
      settledWatermarks[sessionKey] = Math.max(settledWatermarks[sessionKey] ?? -1, watermark)
    }
    for (const [sessionKey, watermarks] of Object.entries(coverage.reviewedWatermarks)) {
      const values = reviewedWatermarks.get(sessionKey) ?? new Set<number>()
      watermarks.forEach(watermark => values.add(watermark))
      reviewedWatermarks.set(sessionKey, values)
    }
    for (const action of acceptedActions) {
      action.acceptedTriggerIds.forEach(id => acceptedPartialTriggerIds.add(id))
      for (const [sessionKey, watermark] of Object.entries(action.settledWatermarks)) {
        acceptedWatermarks[sessionKey] = Math.max(acceptedWatermarks[sessionKey] ?? -1, watermark)
      }
    }
  }
  for (const trigger of triggers) {
    triggerCoverage.set(
      trigger.triggerId,
      acceptedPartialTriggerIds.has(trigger.triggerId) ||
        trigger.evidenceWatermark <= (acceptedWatermarks[trigger.sessionKey] ?? -1)
        ? 'accepted-partial'
        : reviewedTriggerIds.has(trigger.triggerId) ||
            trigger.evidenceWatermark <= (settledWatermarks[trigger.sessionKey] ?? -1)
          ? 'reviewed'
          : reviewedWatermarks.get(trigger.sessionKey)?.has(trigger.evidenceWatermark)
            ? 'partial'
            : 'pending',
    )
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
    reviews: [...reviews]
      .sort(
        (left, right) =>
          Date.parse(left.manifest.completedAt) - Date.parse(right.manifest.completedAt) ||
          left.manifest.reviewId.localeCompare(right.manifest.reviewId),
      )
      .map(review => {
        const preview = limitText(review.submissions)
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
          choices: review.ledger?.entries ?? [],
          ...(review.ledger?.summary ? { summary: review.ledger.summary } : {}),
          submissionsPreview: preview.value,
          submissionsTruncated: preview.truncated,
        }
      }),
    decisions,
    unresolvedDisputes:
      decisions?.lineages
        .flatMap(lineage => lineage.observations)
        .flatMap(item =>
          item.activeDisputeActionId === undefined
            ? []
            : [
                {
                  actionId: item.activeDisputeActionId,
                  targetObservationId: item.observation.observationId,
                },
              ],
        )
        .sort((left, right) => left.actionId.localeCompare(right.actionId)) ?? [],
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
