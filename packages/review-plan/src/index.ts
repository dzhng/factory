import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  assertOwnedRecordPath,
  canonicalJson,
  makeOwnedPath,
  objectOwnedPath,
  parseCodeManifest,
  reviewSubjectCoverageId,
  validateObjectRef,
  validatePublicRecord,
  type AssociationBatch,
  type AvailablePullRequestObservation,
  type CoverageAction,
  type EvidenceEnvelope,
  type Limitation,
  type LimitationCode,
  type ObjectRef,
  type OwnedPath,
  type RecordId,
  type RepositoryObservation,
  type SessionIdentity,
  type ReviewLedger,
  type ReviewEvidenceSelection as ContractReviewEvidenceSelection,
  type ReviewerSettings,
  type ReviewTrigger,
  type SessionPullRequestAssociation,
  type TurnManifest,
} from '@factory/contract'
import { verifyAssociationBatch } from '@factory/github'
import { inventoryConfinedTree, readConfinedFile } from '@factory/repository'

export type ReviewSubject =
  | { kind: 'workspace'; observation: RepositoryObservation }
  | { kind: 'pull-request'; observation: AvailablePullRequestObservation }

export type EvidenceClassification =
  | 'included'
  | 'readable-partial'
  | 'unavailable'
  | 'corrupt'
  | 'unsafe'
  | 'excluded'
  | 'weak-context'

export type CandidateScopeProof =
  | { kind: 'workspace-store'; repositoryId: string }
  | { kind: 'prior-plan'; reviewId: RecordId }
  | { kind: 'diagnostic-only' }

export type CandidateEvidence = {
  identity: SessionIdentity
  trigger: ReviewTrigger
  turn: TurnManifest
  repositoryObservation?: RepositoryObservation
  availability?: Exclude<EvidenceClassification, 'included' | 'weak-context'>
  limitations?: readonly Limitation[]
  events: readonly EvidenceEnvelope[]
  transcript: readonly EvidenceEnvelope[]
}

export type CandidateProblem = {
  triggerId: RecordId
  scopeProof: CandidateScopeProof
  availability: 'unavailable' | 'corrupt' | 'unsafe' | 'excluded'
  limitations: readonly Limitation[]
} & (
  | { kind: 'range'; sessionKey: string; turnId: RecordId; evidenceWatermark: number }
  | { kind: 'opaque-problem' }
)

export type ReviewCandidate = CandidateEvidence | CandidateProblem

export interface PortableRecordReader {
  read(
    path: string,
  ): Promise<
    | { kind: 'readable'; bytes: Uint8Array }
    | { kind: 'missing'; detail: string }
    | { kind: 'unsafe'; detail: string }
  >
  getObject(
    ref: ObjectRef,
  ): Promise<
    | { kind: 'readable'; bytes: Uint8Array }
    | { kind: 'missing'; detail: string }
    | { kind: 'unsafe'; detail: string }
    | { kind: 'excluded-by-limit'; detail: string }
  >
}

export type CandidateRecordDescriptor = {
  triggerId: RecordId
  scopeProof: CandidateScopeProof
}

function decodeCanonicalRecord(path: string, bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value = JSON.parse(text) as unknown
  if (canonicalJson(value) !== text) throw new TypeError('record is not canonical JSON')
  assertOwnedRecordPath(path)
  validatePublicRecord(path, value)
  return value
}

function decodeCanonicalJsonl(path: string, bytes: Uint8Array): EvidenceEnvelope[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.length === 0) return []
  if (!text.endsWith('\n')) throw new TypeError('JSONL record lacks final newline')
  return text
    .trimEnd()
    .split('\n')
    .map(line => {
      const value = JSON.parse(line) as EvidenceEnvelope
      if (canonicalJson(value) !== `${line}\n`)
        throw new TypeError('JSONL envelope is not canonical')
      assertOwnedRecordPath(path)
      validatePublicRecord(path, value)
      return value
    })
}

class CandidateObjectClassificationError extends Error {
  constructor(
    readonly classification: CandidateProblem['availability'],
    readonly limitationCode: LimitationCode,
    message: string,
  ) {
    super(message)
  }
}

async function verifyCandidateObjects(reader: PortableRecordReader, candidate: CandidateEvidence) {
  const refs = new Map<string, ObjectRef>()
  collectObjectRefs(candidate, refs)
  const pending = [...refs.values()]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const ref = pending.shift()!
    const key = canonicalJson(ref)
    if (visited.has(key)) continue
    visited.add(key)
    const result = await reader.getObject(ref)
    if (result.kind !== 'readable') {
      throw new CandidateObjectClassificationError(
        result.kind === 'unsafe'
          ? 'unsafe'
          : result.kind === 'excluded-by-limit'
            ? 'excluded'
            : 'unavailable',
        result.kind === 'excluded-by-limit' ? 'excluded-by-limit' : 'unverified-object',
        result.detail,
      )
    }
    const bytes = result.bytes
    if (bytes.byteLength !== ref.bytes || sha256(bytes) !== ref.sha256) {
      throw new Error(`candidate object failed verification: ${ref.sha256}`)
    }
    if (
      ref.mediaType === 'application/vnd.factory.code-manifest+json' &&
      ref.role === 'workspace-code-manifest'
    ) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (canonicalJson(JSON.parse(text)) !== text)
        throw new Error('code manifest is not canonical')
      const nested = new Map<string, ObjectRef>()
      collectObjectRefs(parseCodeManifest(JSON.parse(text)), nested)
      pending.push(...nested.values())
    }
  }
}

/** Classify one portable trigger graph before pure planning; corrupt siblings do not abort a run. */
export async function loadCandidateEvidence(
  reader: PortableRecordReader,
  descriptor: CandidateRecordDescriptor,
): Promise<ReviewCandidate> {
  const opaqueIdentity = {
    kind: 'opaque-problem' as const,
    triggerId: descriptor.triggerId,
    scopeProof: descriptor.scopeProof,
  }
  const triggerPath = makeOwnedPath('review-triggers', [`${descriptor.triggerId}.json`])
  const problem = (
    classification: CandidateProblem['availability'],
    detail: string,
    limitationCode?: LimitationCode,
    exact?: { sessionKey: string; turnId: RecordId; evidenceWatermark: number },
  ): CandidateProblem => ({
    ...(exact === undefined
      ? opaqueIdentity
      : {
          kind: 'range' as const,
          ...exact,
          triggerId: descriptor.triggerId,
          scopeProof: descriptor.scopeProof,
        }),
    availability: classification,
    limitations: [
      {
        code:
          limitationCode ?? (classification === 'corrupt' ? 'corrupt-input' : 'unverified-object'),
        detail,
      },
    ],
  })
  let trustedExact: { sessionKey: string; turnId: RecordId; evidenceWatermark: number } | undefined
  try {
    const triggerRead = await reader.read(triggerPath)
    if (triggerRead.kind !== 'readable')
      return problem(triggerRead.kind === 'unsafe' ? 'unsafe' : 'unavailable', triggerRead.detail)
    let trigger: ReviewTrigger
    try {
      trigger = decodeCanonicalRecord(triggerPath, triggerRead.bytes) as ReviewTrigger
    } catch (error) {
      return problem('corrupt', error instanceof Error ? error.message : String(error))
    }
    const exact = {
      sessionKey: trigger.sessionKey,
      turnId: trigger.turnId,
      evidenceWatermark: trigger.evidenceWatermark,
    }
    trustedExact = exact
    const identityPath = makeOwnedPath('sessions', [
      trigger.provider,
      trigger.sessionKey,
      'identity.json',
    ])
    const turnRoot = [trigger.provider, trigger.sessionKey, 'turns', trigger.turnId]
    const turnPath = makeOwnedPath('sessions', [...turnRoot, 'manifest.json'])
    const eventsPath = makeOwnedPath('sessions', [...turnRoot, 'events.jsonl'])
    const transcriptPath = makeOwnedPath('sessions', [...turnRoot, 'transcript.jsonl'])
    const [identityRead, turnRead, eventsRead, transcriptRead] = await Promise.all([
      reader.read(identityPath),
      reader.read(turnPath),
      reader.read(eventsPath),
      reader.read(transcriptPath),
    ])
    if (identityRead.kind !== 'readable')
      return problem(
        identityRead.kind === 'unsafe' ? 'unsafe' : 'unavailable',
        identityRead.detail,
        undefined,
        exact,
      )
    if (turnRead.kind !== 'readable')
      return problem(
        turnRead.kind === 'unsafe' ? 'unsafe' : 'unavailable',
        turnRead.detail,
        undefined,
        exact,
      )
    if (eventsRead.kind !== 'readable')
      return problem(
        eventsRead.kind === 'unsafe' ? 'unsafe' : 'unavailable',
        eventsRead.detail,
        undefined,
        exact,
      )
    if (transcriptRead.kind !== 'readable')
      return problem(
        transcriptRead.kind === 'unsafe' ? 'unsafe' : 'unavailable',
        transcriptRead.detail,
        undefined,
        exact,
      )
    const identityRecord = decodeCanonicalRecord(
      identityPath,
      identityRead.bytes,
    ) as SessionIdentity
    const turn = decodeCanonicalRecord(turnPath, turnRead.bytes) as TurnManifest
    const events = decodeCanonicalJsonl(eventsPath, eventsRead.bytes)
    const transcript = decodeCanonicalJsonl(transcriptPath, transcriptRead.bytes)
    if (
      identityRecord.sessionKey !== trigger.sessionKey ||
      identityRecord.provider !== trigger.provider ||
      turn.sessionKey !== trigger.sessionKey ||
      turn.turnId !== trigger.turnId ||
      turn.repositoryObservationId !== trigger.repositoryObservationId
    ) {
      return problem('corrupt', 'trigger, Turn, and descriptor identities do not join')
    }
    let repositoryObservation: RepositoryObservation | undefined
    if (trigger.repositoryObservationId !== undefined) {
      const path = makeOwnedPath('repository-observations', [
        `${trigger.repositoryObservationId}.json`,
      ])
      const read = await reader.read(path)
      if (read.kind !== 'readable')
        return problem(
          read.kind === 'unsafe' ? 'unsafe' : 'unavailable',
          read.detail,
          undefined,
          exact,
        )
      repositoryObservation = decodeCanonicalRecord(path, read.bytes) as RepositoryObservation
      if (repositoryObservation.observationId !== trigger.repositoryObservationId) {
        return problem(
          'corrupt',
          'repository observation identity does not join the Turn',
          undefined,
          exact,
        )
      }
    }
    if (
      repositoryObservation !== undefined &&
      identityRecord.repositoryId !== repositoryObservation.repositoryId
    ) {
      return problem(
        'corrupt',
        'Session identity repository does not own the Turn observation',
        undefined,
        exact,
      )
    }
    const candidate: CandidateEvidence = {
      identity: identityRecord,
      trigger,
      turn,
      repositoryObservation,
      events,
      transcript,
    }
    const raw = new Set(turn.rawObjects.map(ref => canonicalJson(ref)))
    const transcriptRefs = new Set(turn.transcriptObservations.map(ref => canonicalJson(ref)))
    if (events.some(event => !raw.has(canonicalJson(event.raw))))
      return problem(
        'corrupt',
        'event envelope raw object is absent from its Turn',
        undefined,
        exact,
      )
    if (transcript.some(event => !transcriptRefs.has(canonicalJson(event.raw))))
      return problem(
        'corrupt',
        'transcript envelope raw object is absent from its Turn',
        undefined,
        exact,
      )
    await verifyCandidateObjects(reader, candidate)
    return candidate
  } catch (error) {
    if (error instanceof CandidateObjectClassificationError) {
      return problem(error.classification, error.message, error.limitationCode, trustedExact)
    }
    return problem(
      'corrupt',
      error instanceof Error ? error.message : String(error),
      undefined,
      trustedExact,
    )
  }
}

export type CompletedAssociationGroup = {
  batch: AssociationBatch
  evidence: readonly SessionPullRequestAssociation[]
}

export type ReviewEvidenceSelection = ContractReviewEvidenceSelection

export type PriorReview = {
  reviewId: RecordId
  subject: ReviewSubject
  /** Frozen subject digest from the prior plan, not a digest of mutable repository state. */
  subjectFingerprint: string
  subjectAttempt: ReviewSubjectAttempt
  sessionWatermarks: Readonly<Record<string, number>>
  coverageTargetWatermarks: Readonly<Record<string, number>>
  selections: readonly ReviewEvidenceSelection[]
  triggerIds: readonly RecordId[]
  disposition: 'complete' | 'partial' | 'failed'
  policies: ReviewPolicies
  head?: string
  codeManifest?: ObjectRef
  ledger?: ReviewLedger
}

export type FrozenPriorLedger = {
  path: OwnedPath
  ledger: ReviewLedger
  object: ObjectRef
}

export type ReviewPolicies = {
  reviewer: ReviewerSettings
  analyzerVersion: string
  promptVersion: string
  policyVersion: string
  formatVersion: 1
}

export type ReviewSubjectAttempt = {
  fingerprint: string
  coverageId: string
  effect: 'current-included' | 'reviewed-partial' | 'previously-analyzed-unsettled' | 'settled'
  limitations: readonly Limitation[]
}

export type ReviewInputs = {
  mode: 'incremental' | 'full' | 'force'
  subject: ReviewSubject
  candidates: readonly ReviewCandidate[]
  reviews: readonly PriorReview[]
  coverageActions: readonly CoverageAction[]
  associations: readonly CompletedAssociationGroup[]
  policies: ReviewPolicies
  sessionKey?: string
  reviewLimits?: { maxBundleBytes?: number; maxSessions?: number }
}

export type EffectiveReviewLimits = {
  maxBundleBytes: number
  maxSessions: number
  maxFiles: number
  maxObjects: number
  maxDepth: number
  maxStructuredRecordBytes: number
}

export type CoverageView = {
  settledWatermarks: Readonly<Record<string, number>>
  reviewedWatermarks: Readonly<Record<string, readonly number[]>>
  acceptedOpaqueTriggerIds: readonly RecordId[]
  subject?: ReviewSubjectAttempt
}

export type PlannedSessionRange = {
  sessionKey: string
  fromExclusive: number
  toInclusive: number
  triggerIds: readonly RecordId[]
}

export type ReviewPlan = {
  schemaVersion: 1
  status: 'ready' | 'already-reviewed' | 'pending-partial' | 'pending-limit' | 'unavailable'
  subject: ReviewSubject
  subjectFingerprint: string
  subjectAttempt: ReviewSubjectAttempt
  subjectReview: 'none' | 'full-current-code' | 'full-current-pr-diff'
  replayCoveredEvidence: boolean
  fullReviewReason?:
    | 'initial-review'
    | 'explicit-full'
    | 'explicit-force'
    | 'subject-changed'
    | 'limitations-changed'
    | 'policy-changed'
  sessions: readonly PlannedSessionRange[]
  selections: readonly ReviewEvidenceSelection[]
  evidence: readonly CandidateEvidence[]
  sessionWatermarks: Readonly<Record<string, number>>
  coverageTargetWatermarks: Readonly<Record<string, number>>
  triggerIds: readonly RecordId[]
  associationBatchIds: readonly RecordId[]
  associations: readonly CompletedAssociationGroup[]
  priorLedger?: FrozenPriorLedger
  limitations: readonly Limitation[]
  policies: ReviewPolicies
  limits: EffectiveReviewLimits
  objectInventory: readonly ObjectRef[]
}

function effectiveLimits(configured: ReviewInputs['reviewLimits']): EffectiveReviewLimits {
  const clamp = (value: number | undefined, fallback: number, ceiling: number): number =>
    value === undefined || !Number.isSafeInteger(value) || value <= 0
      ? fallback
      : Math.min(value, ceiling)
  return {
    maxBundleBytes: clamp(configured?.maxBundleBytes, 256 * 1024 * 1024, 512 * 1024 * 1024),
    maxSessions: clamp(configured?.maxSessions, 100, 1_000),
    maxFiles: 200_000,
    maxObjects: 100_000,
    maxDepth: 16,
    maxStructuredRecordBytes: 4 * 1024 * 1024,
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareSelection(left: ReviewEvidenceSelection, right: ReviewEvidenceSelection): number {
  return left.triggerId.localeCompare(right.triggerId) || left.kind.localeCompare(right.kind)
}

function compareCanonical(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right))
}

function subjectFingerprint(subject: ReviewSubject): string {
  if (subject.kind === 'workspace') {
    const observation = subject.observation
    return sha256(
      canonicalJson({
        kind: subject.kind,
        ...(observation.git.head === undefined ? {} : { head: observation.git.head }),
        startState: observation.startState,
        endState: observation.endState,
        ...(observation.codeManifest === undefined
          ? {}
          : { codeManifest: observation.codeManifest }),
        ...(observation.stagedPatch === undefined ? {} : { stagedPatch: observation.stagedPatch }),
        ...(observation.unstagedPatch === undefined
          ? {}
          : { unstagedPatch: observation.unstagedPatch }),
      }),
    )
  }
  const observation = subject.observation
  return sha256(
    canonicalJson({
      kind: subject.kind,
      repositoryKey: observation.repositoryKey,
      number: observation.number,
      base: observation.base,
      head: observation.head,
      diff: observation.diff,
      ...(observation.codeManifest === undefined ? {} : { codeManifest: observation.codeManifest }),
    }),
  )
}

function sameSubject(review: PriorReview, subject: ReviewSubject): boolean {
  if (review.subject.kind !== subject.kind) return false
  if (subject.kind === 'workspace') {
    return (
      review.subject.kind === 'workspace' &&
      review.subject.observation.repositoryId === subject.observation.repositoryId
    )
  }
  if (review.subject.kind !== 'pull-request') return false
  return (
    review.subject.observation.repositoryKey === subject.observation.repositoryKey &&
    review.subject.observation.number === subject.observation.number
  )
}

function freezePriorLedger(review: PriorReview | undefined): FrozenPriorLedger | undefined {
  if (review?.ledger === undefined) return undefined
  if (review.ledger.reviewId !== review.reviewId) {
    throw new TypeError('prior ledger must name its review')
  }
  const path =
    review.subject.kind === 'workspace'
      ? makeOwnedPath('reviews', ['workspace', review.reviewId, 'ledger.json'])
      : makeOwnedPath('reviews', [
          'pull-requests',
          'github',
          review.subject.observation.repositoryKey,
          String(review.subject.observation.number),
          review.reviewId,
          'ledger.json',
        ])
  validatePublicRecord(path, review.ledger)
  const bytes = new TextEncoder().encode(canonicalJson(review.ledger))
  return {
    path,
    ledger: review.ledger,
    object: {
      algorithm: 'sha256',
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      mediaType: 'application/vnd.factory.review-ledger+json',
      role: 'prior-review-ledger',
    },
  }
}

function acceptedReviewWatermarks(review: PriorReview): Map<string, Set<number>> {
  const accepted = new Map<string, Set<number>>()
  if (review.disposition === 'failed') return accepted
  for (const selection of review.selections) {
    if (selection.kind !== 'range') continue
    if (!selection.selectedForReview) continue
    if (!['eligible-included', 'eligible-gap'].includes(selection.coverageEffect)) continue
    const values = accepted.get(selection.sessionKey) ?? new Set<number>()
    values.add(selection.evidenceWatermark)
    accepted.set(selection.sessionKey, values)
  }
  return accepted
}

function assertExactAttemptMetadata(review: PriorReview): void {
  const attempted = review.selections.filter(selection =>
    ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect),
  )
  const watermarks = Object.fromEntries(
    [
      ...new Set(
        attempted
          .filter(selection => selection.kind === 'range')
          .map(selection => selection.sessionKey),
      ),
    ]
      .sort()
      .map(sessionKey => [
        sessionKey,
        Math.max(
          ...attempted
            .filter(
              (selection): selection is ReviewEvidenceSelection & { kind: 'range' } =>
                selection.kind === 'range' && selection.sessionKey === sessionKey,
            )
            .map(selection => selection.evidenceWatermark),
        ),
      ]),
  )
  if (canonicalJson(watermarks) !== canonicalJson(review.sessionWatermarks)) {
    throw new TypeError('prior review watermarks differ from exact attempted selections')
  }
  const triggerIds = attempted.map(selection => selection.triggerId).sort()
  if (canonicalJson(triggerIds) !== canonicalJson(review.triggerIds)) {
    throw new TypeError('prior review trigger IDs differ from exact attempted selections')
  }
  const targets = Object.fromEntries(
    [
      ...new Set(
        review.selections
          .filter(selection => selection.kind === 'range')
          .filter(selection =>
            ['eligible-included', 'eligible-gap', 'previously-analyzed'].includes(
              selection.coverageEffect,
            ),
          )
          .map(selection => (selection.kind === 'range' ? selection.sessionKey : '')),
      ),
    ]
      .filter(Boolean)
      .sort()
      .map(sessionKey => [
        sessionKey,
        Math.max(
          ...review.selections
            .filter(
              (selection): selection is ReviewEvidenceSelection & { kind: 'range' } =>
                selection.kind === 'range' &&
                selection.sessionKey === sessionKey &&
                ['eligible-included', 'eligible-gap', 'previously-analyzed'].includes(
                  selection.coverageEffect,
                ),
            )
            .map(selection => selection.evidenceWatermark),
        ),
      ]),
  )
  if (canonicalJson(targets) !== canonicalJson(review.coverageTargetWatermarks)) {
    throw new TypeError('prior review coverage targets differ from exact prefix closure')
  }
}

function exactBlockingCodes(
  review: PriorReview,
  watermarkBySession: Readonly<Record<string, number>>,
  acceptedTriggerIds: readonly RecordId[],
): LimitationCode[] {
  return [
    ...new Set([
      ...review.selections
        .filter(
          selection =>
            selection.kind === 'range' &&
            selection.evidenceWatermark <= (watermarkBySession[selection.sessionKey] ?? -1),
        )
        .filter(selection => selection.coverageEffect === 'eligible-gap')
        .flatMap(selection => selection.limitations.map(limitation => limitation.code)),
      ...review.selections
        .filter(
          selection =>
            selection.kind === 'opaque-problem' && acceptedTriggerIds.includes(selection.triggerId),
        )
        .flatMap(selection => selection.limitations.map(limitation => limitation.code)),
    ]),
  ].sort()
}

/** Fold accepted coverage and analyzed ranges without editing append-only reviews or triggers. */
export function foldCoverage(
  input: Pick<ReviewInputs, 'subject' | 'reviews' | 'coverageActions'>,
): CoverageView {
  const settled: Record<string, number> = {}
  const reviewed = new Map<string, Set<number>>()
  const acceptedOpaque = new Set<RecordId>()
  let subjectCoverage: ReviewSubjectAttempt | undefined
  const allReviews = [...input.reviews].sort((left, right) =>
    left.reviewId.localeCompare(right.reviewId),
  )
  const reviews = allReviews.filter(review => sameSubject(review, input.subject))
  for (const review of reviews) {
    assertExactAttemptMetadata(review)
    if (
      review.subjectAttempt.fingerprint !== review.subjectFingerprint ||
      canonicalJson(review.subjectAttempt.limitations) !==
        canonicalJson([...review.subjectAttempt.limitations].sort(compareCanonical))
    ) {
      throw new TypeError('prior review subject attempt is invalid')
    }
    if (review.disposition !== 'failed') {
      subjectCoverage = {
        ...review.subjectAttempt,
        effect:
          review.subjectAttempt.effect === 'settled' ||
          (review.disposition === 'complete' && review.subjectAttempt.limitations.length === 0)
            ? 'settled'
            : review.subjectAttempt.effect,
      }
    }
    if (review.disposition === 'complete') {
      for (const [sessionKey, watermark] of Object.entries(review.coverageTargetWatermarks)) {
        const priorReviewed = reviewed.get(sessionKey) ?? new Set<number>()
        const selections = review.selections.filter(
          (item): item is ReviewEvidenceSelection & { kind: 'range' } =>
            item.kind === 'range' &&
            item.sessionKey === sessionKey &&
            item.evidenceWatermark <= watermark,
        )
        if (
          selections.length === 0 ||
          selections.some(
            item =>
              item.coverageEffect !== 'eligible-included' &&
              !(
                item.coverageEffect === 'previously-analyzed' &&
                (item.evidenceWatermark <= (settled[sessionKey] ?? 0) ||
                  priorReviewed.has(item.evidenceWatermark))
              ),
          )
        ) {
          throw new TypeError('complete review contains an unsettled evidence selection')
        }
        settled[sessionKey] = Math.max(settled[sessionKey] ?? 0, watermark)
      }
      if (
        review.selections.some(
          selection =>
            selection.kind === 'opaque-problem' && selection.coverageEffect === 'eligible-gap',
        )
      ) {
        throw new TypeError('complete review contains an opaque attempted problem')
      }
    }
    for (const [sessionKey, values] of acceptedReviewWatermarks(review)) {
      const existing = reviewed.get(sessionKey) ?? new Set<number>()
      values.forEach(value => existing.add(value))
      reviewed.set(sessionKey, existing)
    }
  }
  const byId = new Map(allReviews.map(review => [review.reviewId, review]))
  for (const action of [...input.coverageActions].sort((a, b) =>
    a.actionId.localeCompare(b.actionId),
  )) {
    const review = byId.get(action.reviewId)
    if (review === undefined) throw new TypeError('coverage action names no review')
    if (!sameSubject(review, input.subject)) continue
    if (review.disposition !== 'partial') {
      throw new TypeError('coverage action must name one partial review')
    }
    for (const [sessionKey, watermark] of Object.entries(action.settledWatermarks)) {
      if (watermark > (review.coverageTargetWatermarks[sessionKey] ?? -1)) {
        throw new TypeError('coverage action exceeds its review watermark')
      }
      if (
        !review.selections.some(
          selection =>
            selection.kind === 'range' &&
            selection.sessionKey === sessionKey &&
            selection.evidenceWatermark === watermark &&
            ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect),
        )
      ) {
        throw new TypeError('coverage action watermark must name an exact attempted boundary')
      }
    }
    const opaqueBlocking = review.selections
      .filter(
        selection =>
          selection.kind === 'opaque-problem' && selection.coverageEffect === 'eligible-gap',
      )
      .map(selection => selection.triggerId)
      .sort()
    const acceptedIds = [...new Set(action.acceptedTriggerIds)].sort()
    if (acceptedIds.some(id => !opaqueBlocking.includes(id))) {
      throw new TypeError('coverage action names an unattempted opaque trigger')
    }
    const expectedCodes = exactBlockingCodes(review, action.settledWatermarks, acceptedIds)
    const actualCodes = [...new Set(action.acceptedLimitations)].sort()
    if (canonicalJson(expectedCodes) !== canonicalJson(actualCodes)) {
      throw new TypeError('coverage action must accept the exact blocking limitations')
    }
    for (const [sessionKey, watermark] of Object.entries(action.settledWatermarks)) {
      settled[sessionKey] = Math.max(settled[sessionKey] ?? 0, watermark)
    }
    acceptedIds.forEach(id => acceptedOpaque.add(id))
    if (action.acceptedSubject !== undefined) {
      if (
        action.acceptedSubject.fingerprint !== review.subjectAttempt.fingerprint ||
        action.acceptedSubject.coverageId !== review.subjectAttempt.coverageId
      ) {
        throw new TypeError('coverage action subject fingerprint differs from its review')
      }
      const expected = [
        ...new Set(review.subjectAttempt.limitations.map(limitation => limitation.code)),
      ].sort()
      const actual = [...new Set(action.acceptedSubject.limitations)].sort()
      if (canonicalJson(expected) !== canonicalJson(actual)) {
        throw new TypeError('coverage action must accept exact subject limitations')
      }
      subjectCoverage = { ...review.subjectAttempt, effect: 'settled' }
    }
  }
  return {
    settledWatermarks: Object.fromEntries(Object.entries(settled).sort()),
    reviewedWatermarks: Object.fromEntries(
      [...reviewed]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, values]) => [key, [...values].sort((left, right) => left - right)]),
    ),
    acceptedOpaqueTriggerIds: [...acceptedOpaque].sort(),
    ...(subjectCoverage === undefined ? {} : { subject: subjectCoverage }),
  }
}

function collectObjectRefs(value: unknown, refs: Map<string, ObjectRef>): void {
  if (Array.isArray(value)) {
    value.forEach(item => collectObjectRefs(item, refs))
    return
  }
  if (value === null || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (
    record.algorithm === 'sha256' &&
    typeof record.sha256 === 'string' &&
    typeof record.bytes === 'number' &&
    typeof record.mediaType === 'string' &&
    typeof record.role === 'string'
  ) {
    const ref = record as ObjectRef
    validateObjectRef(ref)
    refs.set(canonicalJson(ref), ref)
    return
  }
  Object.values(record).forEach(item => collectObjectRefs(item, refs))
}

function visibleAssociationSessions(
  subject: ReviewSubject,
  groups: readonly CompletedAssociationGroup[],
): {
  sessions: Set<string>
  groups: CompletedAssociationGroup[]
  invalidated: boolean
  provenance: Map<
    string,
    Array<{ batchId: RecordId; evidenceId: RecordId; kind: 'verified-exact' | 'manual-asserted' }>
  >
} {
  if (subject.kind !== 'pull-request')
    return { sessions: new Set(), groups: [], invalidated: false, provenance: new Map() }
  const sessions = new Set<string>()
  const provenance = new Map<
    string,
    Array<{ batchId: RecordId; evidenceId: RecordId; kind: 'verified-exact' | 'manual-asserted' }>
  >()
  let invalidated = false
  const visibleGroups: CompletedAssociationGroup[] = []
  for (const group of [...groups].sort((a, b) => a.batch.batchId.localeCompare(b.batch.batchId))) {
    if (
      group.batch.repositoryKey !== subject.observation.repositoryKey ||
      group.batch.number !== subject.observation.number ||
      group.batch.pullRequestObservationId !== subject.observation.observationId
    )
      continue
    if (!verifyAssociationBatch(group.batch, subject.observation, group.evidence)) continue
    visibleGroups.push({
      batch: group.batch,
      evidence: [...group.evidence].sort((left, right) =>
        left.evidenceId.localeCompare(right.evidenceId),
      ),
    })
    for (const evidence of group.evidence) {
      if (evidence.pullRequestObservationId !== subject.observation.observationId) continue
      if (evidence.kind === 'invalidation') {
        invalidated = true
      } else if (evidence.strength === 'verified' || evidence.kind === 'manual') {
        sessions.add(evidence.sessionKey)
        const entries = provenance.get(evidence.sessionKey) ?? []
        entries.push({
          batchId: group.batch.batchId,
          evidenceId: evidence.evidenceId,
          kind: evidence.kind === 'manual' ? 'manual-asserted' : 'verified-exact',
        })
        provenance.set(evidence.sessionKey, entries)
      }
    }
  }
  for (const entries of provenance.values()) {
    entries.sort(
      (left, right) =>
        left.batchId.localeCompare(right.batchId) ||
        left.evidenceId.localeCompare(right.evidenceId),
    )
  }
  return { sessions, groups: visibleGroups, invalidated, provenance }
}

function candidateClassification(candidate: CandidateEvidence): EvidenceClassification {
  if (candidate.availability !== undefined) return candidate.availability
  if (candidate.trigger.materialization === 'partial' || candidate.turn.limitations.length > 0) {
    return 'readable-partial'
  }
  return 'included'
}

type CandidateScope = 'verified' | 'weak' | 'out-of-scope'

function candidateScope(
  subject: ReviewSubject,
  candidate: ReviewCandidate,
  association: ReturnType<typeof visibleAssociationSessions>,
  reviews: readonly PriorReview[],
  workspaceAnchors: ReadonlyMap<string, number>,
): CandidateScope {
  const identity = candidateIdentity(candidate)
  if ('trigger' in candidate) {
    if (subject.kind === 'pull-request') {
      return association.sessions.has(identity.kind === 'range' ? identity.sessionKey : '')
        ? 'verified'
        : 'out-of-scope'
    }
    if (candidate.identity.repositoryId !== subject.observation.repositoryId) return 'out-of-scope'
    if (
      candidate.repositoryObservation !== undefined &&
      subjectFingerprint({ kind: 'workspace', observation: candidate.repositoryObservation }) ===
        subjectFingerprint(subject)
    ) {
      return 'verified'
    }
    if (
      (workspaceAnchors.get(candidate.trigger.sessionKey) ?? -1) >=
      candidate.trigger.evidenceWatermark
    ) {
      return 'verified'
    }
    const candidateGit = candidate.repositoryObservation?.git
    return candidateGit !== undefined &&
      !candidateGit.detached &&
      !subject.observation.git.detached &&
      candidateGit.branch !== undefined &&
      candidateGit.branch.length > 0 &&
      candidateGit.branch === subject.observation.git.branch
      ? 'weak'
      : 'out-of-scope'
  }
  if (subject.kind === 'workspace') {
    if (
      candidate.scopeProof.kind !== 'workspace-store' ||
      candidate.scopeProof.repositoryId !== subject.observation.repositoryId
    )
      return 'out-of-scope'
    return 'verified'
  }
  if (identity.kind === 'range' && association.sessions.has(identity.sessionKey)) return 'verified'
  const priorPlanReviewId =
    candidate.scopeProof.kind === 'prior-plan' ? candidate.scopeProof.reviewId : undefined
  return priorPlanReviewId !== undefined &&
    reviews.some(
      review =>
        review.reviewId === priorPlanReviewId &&
        sameSubject(review, subject) &&
        review.selections.some(selection => selection.triggerId === identity.triggerId),
    )
    ? 'verified'
    : 'out-of-scope'
}

function candidateIdentity(candidate: ReviewCandidate) {
  if ('trigger' in candidate) {
    return {
      kind: 'range' as const,
      sessionKey: candidate.trigger.sessionKey,
      triggerId: candidate.trigger.triggerId,
      turnId: candidate.trigger.turnId,
      evidenceWatermark: candidate.trigger.evidenceWatermark,
    }
  }
  return candidate.kind === 'range'
    ? {
        kind: 'range' as const,
        sessionKey: candidate.sessionKey,
        triggerId: candidate.triggerId,
        turnId: candidate.turnId,
        evidenceWatermark: candidate.evidenceWatermark,
      }
    : { kind: 'opaque-problem' as const, triggerId: candidate.triggerId }
}

function assertVerifiedInputs(input: ReviewInputs): void {
  if (input.subject.kind === 'workspace') {
    validatePublicRecord(
      makeOwnedPath('repository-observations', [`${input.subject.observation.observationId}.json`]),
      input.subject.observation,
    )
  } else {
    validatePublicRecord(
      makeOwnedPath('pull-requests', [
        'github',
        input.subject.observation.repositoryKey,
        String(input.subject.observation.number),
        'observations',
        `${input.subject.observation.observationId}.json`,
      ]),
      input.subject.observation,
    )
  }
  const candidateTriggerIds = input.candidates.map(
    candidate => candidateIdentity(candidate).triggerId,
  )
  if (new Set(candidateTriggerIds).size !== candidateTriggerIds.length) {
    throw new TypeError('review candidates contain a duplicate trigger')
  }
  for (const candidate of input.candidates) {
    if (!('trigger' in candidate)) continue
    if (
      candidate.trigger.turnId !== candidate.turn.turnId ||
      candidate.identity.sessionKey !== candidate.turn.sessionKey ||
      candidate.identity.provider !== candidate.trigger.provider ||
      candidate.trigger.sessionKey !== candidate.turn.sessionKey ||
      candidate.trigger.repositoryObservationId !== candidate.turn.repositoryObservationId ||
      (candidate.repositoryObservation !== undefined &&
        (candidate.repositoryObservation.observationId !== candidate.turn.repositoryObservationId ||
          candidate.repositoryObservation.repositoryId !== candidate.identity.repositoryId))
    ) {
      throw new TypeError('review candidate record identities do not join')
    }
    const eventSequences = candidate.events.map(event => event.sequence)
    const expectedSequences = Array.from(
      { length: candidate.turn.eventRange.last - candidate.turn.eventRange.first + 1 },
      (_, index) => candidate.turn.eventRange.first + index,
    )
    if (
      candidate.trigger.materialization === 'complete' &&
      canonicalJson(eventSequences) !== canonicalJson(expectedSequences)
    ) {
      throw new TypeError('complete review candidate does not contain its exact event range')
    }
    if (candidate.trigger.evidenceWatermark !== candidate.turn.eventRange.last) {
      throw new TypeError('review trigger watermark does not match its Turn range')
    }
    if (
      candidate.repositoryObservation?.codeManifest !== undefined &&
      candidate.repositoryObservation.worktreeFingerprint !==
        candidate.repositoryObservation.codeManifest.sha256
    ) {
      throw new TypeError('repository fingerprint does not match its code manifest bytes')
    }
  }
  for (const review of input.reviews) {
    if (review.subjectFingerprint !== subjectFingerprint(review.subject)) {
      throw new TypeError('prior review subject fingerprint does not match its frozen subject')
    }
    const ordered = [...review.selections].sort(compareSelection)
    if (canonicalJson(ordered) !== canonicalJson(review.selections)) {
      throw new TypeError('prior review selections are not in canonical order')
    }
  }
}

/** Freeze deterministic selection from already-validated append-only evidence. */
export function planReview(input: ReviewInputs): ReviewPlan {
  assertVerifiedInputs(input)
  const limits = effectiveLimits(input.reviewLimits)
  const fingerprint = subjectFingerprint(input.subject)
  const coverage = foldCoverage(input)
  const prior = [...input.reviews]
    .filter(review => sameSubject(review, input.subject) && review.disposition !== 'failed')
    .sort((left, right) => right.reviewId.localeCompare(left.reviewId))[0]
  const association = visibleAssociationSessions(input.subject, input.associations)
  const workspaceAnchors = new Map<string, number>()
  if (input.subject.kind === 'workspace') {
    for (const candidate of input.candidates) {
      if (
        'trigger' in candidate &&
        candidate.repositoryObservation !== undefined &&
        candidate.identity.repositoryId === input.subject.observation.repositoryId &&
        subjectFingerprint({ kind: 'workspace', observation: candidate.repositoryObservation }) ===
          fingerprint
      ) {
        workspaceAnchors.set(
          candidate.trigger.sessionKey,
          Math.max(
            workspaceAnchors.get(candidate.trigger.sessionKey) ?? -1,
            candidate.trigger.evidenceWatermark,
          ),
        )
      }
    }
  }
  const priorLedger = freezePriorLedger(prior)
  const subjectLimitations = [...input.subject.observation.limitations]
    .filter(
      (item, index, all) =>
        all.findIndex(other => canonicalJson(other) === canonicalJson(item)) === index,
    )
    .sort(compareCanonical)
  const coverageId = reviewSubjectCoverageId(fingerprint, subjectLimitations)
  const changed = prior !== undefined && prior.subjectFingerprint !== fingerprint
  const limitationsChanged = prior !== undefined && prior.subjectAttempt.coverageId !== coverageId
  const policyChanged =
    prior !== undefined && canonicalJson(prior.policies) !== canonicalJson(input.policies)
  const fullReviewReason =
    input.mode === 'full'
      ? ('explicit-full' as const)
      : input.mode === 'force'
        ? ('explicit-force' as const)
        : prior === undefined
          ? ('initial-review' as const)
          : changed || association.invalidated
            ? ('subject-changed' as const)
            : limitationsChanged
              ? ('limitations-changed' as const)
              : policyChanged
                ? ('policy-changed' as const)
                : undefined
  const replayCoveredEvidence = input.mode === 'full' || input.mode === 'force'
  const priorSubjectAttempt =
    coverage.subject?.coverageId === coverageId ? coverage.subject : undefined
  const previouslyReviewed = coverage.reviewedWatermarks
  const selections: ReviewEvidenceSelection[] = []
  const includedCandidates: CandidateEvidence[] = []
  const admittedSessions = new Set<string>()
  const sortedCandidates = [...input.candidates].sort((left, right) => {
    const leftIdentity = candidateIdentity(left)
    const rightIdentity = candidateIdentity(right)
    return (
      (candidateScope(input.subject, left, association, input.reviews, workspaceAnchors) ===
      'verified'
        ? 0
        : 1) -
        (candidateScope(input.subject, right, association, input.reviews, workspaceAnchors) ===
        'verified'
          ? 0
          : 1) ||
      (leftIdentity.kind === 'range' ? leftIdentity.sessionKey : '').localeCompare(
        rightIdentity.kind === 'range' ? rightIdentity.sessionKey : '',
      ) ||
      (leftIdentity.kind === 'range' ? leftIdentity.evidenceWatermark : -1) -
        (rightIdentity.kind === 'range' ? rightIdentity.evidenceWatermark : -1) ||
      leftIdentity.triggerId.localeCompare(rightIdentity.triggerId)
    )
  })
  for (const candidate of sortedCandidates) {
    const identity = candidateIdentity(candidate)
    const scope = candidateScope(
      input.subject,
      candidate,
      association,
      input.reviews,
      workspaceAnchors,
    )
    let classification =
      'trigger' in candidate ? candidateClassification(candidate) : candidate.availability
    let reason: string = classification
    if (scope === 'out-of-scope') {
      classification = 'excluded'
      reason = 'unproven-subject-scope'
    } else if (
      identity.kind === 'range' &&
      input.sessionKey !== undefined &&
      identity.sessionKey !== input.sessionKey
    ) {
      classification = 'excluded'
      reason = 'different-session'
    } else if (
      identity.kind === 'range' &&
      input.subject.kind === 'pull-request' &&
      !association.sessions.has(identity.sessionKey)
    ) {
      classification = 'excluded'
      reason = 'no-completed-exact-association'
    } else if (
      !replayCoveredEvidence &&
      coverage.acceptedOpaqueTriggerIds.includes(identity.triggerId)
    ) {
      classification = 'excluded'
      reason = 'previously-accepted-opaque-problem'
    } else if (
      identity.kind === 'range' &&
      !replayCoveredEvidence &&
      (previouslyReviewed[identity.sessionKey] ?? []).includes(identity.evidenceWatermark)
    ) {
      classification = 'excluded'
      reason = 'previously-reviewed-range'
    } else if (
      identity.kind === 'range' &&
      !admittedSessions.has(identity.sessionKey) &&
      admittedSessions.size >= limits.maxSessions
    ) {
      classification = 'excluded'
      reason = 'session-limit'
    }
    const coverageEffect: ReviewEvidenceSelection['coverageEffect'] =
      reason === 'different-session' ||
      reason === 'no-completed-exact-association' ||
      reason === 'unproven-subject-scope'
        ? 'out-of-scope'
        : reason === 'previously-reviewed-range' || reason === 'previously-accepted-opaque-problem'
          ? 'previously-analyzed'
          : reason === 'session-limit' ||
              candidate.limitations?.some(item => item.code === 'excluded-by-limit')
            ? 'deferred-by-limit'
            : scope === 'weak' || classification === 'weak-context'
              ? 'context-only'
              : classification === 'included'
                ? 'eligible-included'
                : 'eligible-gap'
    if (scope === 'weak' && classification !== 'excluded') classification = 'weak-context'
    const selectedForReview =
      ['included', 'readable-partial', 'weak-context'].includes(classification) &&
      coverageEffect !== 'deferred-by-limit'
    const commonSelection = {
      triggerId: identity.triggerId,
      selectedForReview,
      coverageEffect,
      classification,
      reason,
      limitations: [
        ...('trigger' in candidate ? candidate.trigger.limitations : []),
        ...('trigger' in candidate ? candidate.turn.limitations : []),
        ...(candidate.limitations ?? []),
        ...(reason === 'session-limit'
          ? [{ code: 'excluded-by-limit' as const, detail: 'review Session limit reached' }]
          : []),
      ]
        .filter(
          (item, index, all) =>
            all.findIndex(other => canonicalJson(other) === canonicalJson(item)) === index,
        )
        .sort((a, b) => a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail)),
      ...(input.subject.kind === 'pull-request' && identity.kind === 'range'
        ? (() => {
            const provenance = association.provenance.get(identity.sessionKey) ?? []
            if (provenance.length === 0) return {}
            return {
              association: {
                proofs: provenance.map(item => ({
                  batchId: item.batchId,
                  evidenceId: item.evidenceId,
                  authority: item.kind,
                })),
              },
            }
          })()
        : {}),
    }
    const selection: ReviewEvidenceSelection =
      identity.kind === 'range'
        ? {
            ...commonSelection,
            kind: 'range',
            sessionKey: identity.sessionKey,
            turnId: identity.turnId,
            evidenceWatermark: identity.evidenceWatermark,
          }
        : { ...commonSelection, kind: 'opaque-problem' }
    selections.push(selection)
    if (['included', 'readable-partial', 'weak-context'].includes(classification)) {
      if ('trigger' in candidate) includedCandidates.push(candidate)
      if (identity.kind === 'range') admittedSessions.add(identity.sessionKey)
    }
  }
  selections.sort(compareSelection)
  const coverageCandidates = includedCandidates.filter(
    candidate =>
      candidateScope(input.subject, candidate, association, input.reviews, workspaceAnchors) ===
      'verified',
  )
  const sessions = new Map<string, CandidateEvidence[]>()
  for (const candidate of coverageCandidates) {
    const values = sessions.get(candidate.trigger.sessionKey) ?? []
    values.push(candidate)
    sessions.set(candidate.trigger.sessionKey, values)
  }
  const plannedSessions = [...sessions]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sessionKey, values]) => ({
      sessionKey,
      fromExclusive: replayCoveredEvidence ? 0 : (coverage.settledWatermarks[sessionKey] ?? 0),
      toInclusive: Math.max(...values.map(value => value.trigger.evidenceWatermark)),
      triggerIds: values.map(value => value.trigger.triggerId).sort(),
    }))
  const attemptedRangeSelections = selections.filter(
    (selection): selection is ReviewEvidenceSelection & { kind: 'range' } =>
      selection.kind === 'range' &&
      ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect),
  )
  const sessionWatermarks = Object.fromEntries(
    [...new Set(attemptedRangeSelections.map(selection => selection.sessionKey))]
      .sort()
      .map(sessionKey => [
        sessionKey,
        Math.max(
          ...attemptedRangeSelections
            .filter(selection => selection.sessionKey === sessionKey)
            .map(selection => selection.evidenceWatermark),
        ),
      ]),
  )
  const targetRangeSelections = selections.filter(
    (selection): selection is ReviewEvidenceSelection & { kind: 'range' } =>
      selection.kind === 'range' &&
      ['eligible-included', 'eligible-gap', 'previously-analyzed'].includes(
        selection.coverageEffect,
      ),
  )
  const coverageTargetWatermarks = Object.fromEntries(
    [...new Set(targetRangeSelections.map(selection => selection.sessionKey))]
      .sort()
      .map(sessionKey => [
        sessionKey,
        Math.max(
          ...targetRangeSelections
            .filter(selection => selection.sessionKey === sessionKey)
            .map(selection => selection.evidenceWatermark),
        ),
      ]),
  )
  const refs = new Map<string, ObjectRef>()
  collectObjectRefs(input.subject, refs)
  includedCandidates.forEach(candidate => collectObjectRefs(candidate, refs))
  if (priorLedger !== undefined) collectObjectRefs(priorLedger.ledger, refs)
  if (priorLedger !== undefined) collectObjectRefs(priorLedger.object, refs)
  association.groups.forEach(group => collectObjectRefs(group, refs))
  const foundationalUnavailable =
    input.subject.kind === 'pull-request'
      ? input.subject.observation.availability !== 'available'
      : input.subject.observation.codeManifest === undefined
  const subjectReview: ReviewPlan['subjectReview'] =
    input.subject.kind === 'pull-request'
      ? fullReviewReason !== undefined || includedCandidates.length > 0
        ? 'full-current-pr-diff'
        : 'none'
      : fullReviewReason !== undefined
        ? 'full-current-code'
        : 'none'
  const subjectAttempt: ReviewSubjectAttempt =
    subjectReview !== 'none'
      ? {
          fingerprint,
          coverageId,
          effect: subjectLimitations.length === 0 ? 'current-included' : 'reviewed-partial',
          limitations: subjectLimitations,
        }
      : priorSubjectAttempt?.effect === 'settled'
        ? {
            fingerprint,
            coverageId,
            effect: 'settled',
            limitations: priorSubjectAttempt.limitations,
          }
        : {
            fingerprint,
            coverageId,
            effect: 'previously-analyzed-unsettled',
            limitations: priorSubjectAttempt?.limitations ?? subjectLimitations,
          }
  const hasReviewableEvidence = includedCandidates.length > 0 || subjectReview !== 'none'
  const status = foundationalUnavailable
    ? 'unavailable'
    : !hasReviewableEvidence &&
        selections.some(selection => selection.coverageEffect === 'deferred-by-limit')
      ? 'pending-limit'
      : !hasReviewableEvidence &&
          selections.some(selection => selection.coverageEffect === 'eligible-gap')
        ? 'pending-partial'
        : !hasReviewableEvidence && subjectAttempt.effect === 'previously-analyzed-unsettled'
          ? 'pending-partial'
          : !hasReviewableEvidence && prior?.subjectFingerprint === fingerprint && !policyChanged
            ? 'already-reviewed'
            : 'ready'
  const limitations = [
    ...subjectLimitations,
    ...selections
      .filter(
        selection => !['eligible-included', 'context-only'].includes(selection.coverageEffect),
      )
      .flatMap(selection => selection.limitations),
  ]
    .filter(
      (item, index, all) =>
        all.findIndex(other => canonicalJson(other) === canonicalJson(item)) === index,
    )
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail),
    )
  return {
    schemaVersion: 1,
    status,
    subject: input.subject,
    subjectFingerprint: fingerprint,
    subjectAttempt,
    subjectReview,
    replayCoveredEvidence,
    ...(fullReviewReason === undefined ? {} : { fullReviewReason }),
    sessions: plannedSessions,
    selections,
    evidence: includedCandidates,
    sessionWatermarks,
    coverageTargetWatermarks,
    triggerIds: selections
      .filter(selection => ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect))
      .map(selection => selection.triggerId)
      .sort(),
    associationBatchIds: association.groups.map(group => group.batch.batchId).sort(),
    associations: association.groups,
    ...(priorLedger === undefined ? {} : { priorLedger }),
    limitations,
    policies: input.policies,
    limits,
    objectInventory: [...refs.values()].sort(compareCanonical),
  }
}

export type ReviewBundleManifest = {
  schemaVersion: 1
  format: 'factory-review-bundle'
  plan: ReviewPlanRecord
  inventory: readonly ObjectRef[]
  files: readonly {
    path: string
    kind: 'record' | 'object'
    sha256: string
    bytes: number
  }[]
}

export type ReviewPlanRecord = Omit<
  ReviewPlan,
  'subject' | 'evidence' | 'associations' | 'priorLedger' | 'objectInventory'
> & {
  subject:
    | { kind: 'workspace'; repositoryId: string; observationId: string }
    | {
        kind: 'pull-request'
        provider: 'github'
        repositoryKey: string
        number: number
        observationId: string
      }
  priorLedger?: { path: string; object: ObjectRef }
}

/** Runtime authority for compact plans crossing process or bundle boundaries. */
export function validateReviewPlanRecord(plan: ReviewPlanRecord): void {
  const exactKeys = [
    'schemaVersion',
    'status',
    'subject',
    'subjectFingerprint',
    'subjectAttempt',
    'subjectReview',
    'replayCoveredEvidence',
    'fullReviewReason',
    'sessions',
    'selections',
    'sessionWatermarks',
    'coverageTargetWatermarks',
    'triggerIds',
    'associationBatchIds',
    'priorLedger',
    'limitations',
    'policies',
    'limits',
  ]
  const keys = Object.keys(plan)
  if (keys.some(key => !exactKeys.includes(key)))
    throw new TypeError('review plan has unknown fields')
  if (
    plan.schemaVersion !== 1 ||
    !['ready', 'already-reviewed', 'pending-partial', 'pending-limit', 'unavailable'].includes(
      plan.status,
    ) ||
    !['none', 'full-current-code', 'full-current-pr-diff'].includes(plan.subjectReview) ||
    typeof plan.replayCoveredEvidence !== 'boolean'
  ) {
    throw new TypeError('review plan has an invalid discriminator')
  }
  const reviewId = 'review_00000000000000000000000000' as RecordId
  const reviewPath =
    plan.subject.kind === 'workspace'
      ? makeOwnedPath('reviews', ['workspace', reviewId, 'manifest.json'])
      : makeOwnedPath('reviews', [
          'pull-requests',
          plan.subject.provider,
          plan.subject.repositoryKey,
          String(plan.subject.number),
          reviewId,
          'manifest.json',
        ])
  const validationDisposition =
    plan.subjectAttempt.effect === 'reviewed-partial' ||
    plan.selections.some(selection => selection.coverageEffect === 'eligible-gap') ||
    plan.limitations.length > 0
      ? 'partial'
      : 'complete'
  validatePublicRecord(reviewPath, {
    schemaVersion: 1,
    reviewId,
    subject:
      plan.subject.kind === 'workspace'
        ? { kind: 'workspace', repositoryObservationId: plan.subject.observationId }
        : plan.subject,
    patches: [],
    sessionWatermarks: plan.sessionWatermarks,
    coverageTargetWatermarks: plan.coverageTargetWatermarks,
    subjectFingerprint: plan.subjectFingerprint,
    subjectAttempt: plan.subjectAttempt,
    evidenceSelections: plan.selections,
    triggerIds: plan.triggerIds,
    associationBatchIds: plan.associationBatchIds,
    limitations: plan.limitations,
    reviewer: plan.policies.reviewer,
    analyzerVersion: plan.policies.analyzerVersion,
    promptVersion: plan.policies.promptVersion,
    policyVersion: plan.policies.policyVersion,
    formatVersion: plan.policies.formatVersion,
    bundleSha256: '0'.repeat(64),
    containerImageDigest: 'validation-only',
    providerCliVersion: 'validation-only',
    hostPlatform: 'validation-only',
    startedAt: '2000-01-01T00:00:00Z',
    completedAt: '2000-01-01T00:00:00Z',
    disposition: validationDisposition,
  })
  const canonicalIds = (values: readonly RecordId[]) => [...new Set(values)].sort()
  if (
    canonicalJson(canonicalIds(plan.triggerIds)) !== canonicalJson(plan.triggerIds) ||
    canonicalJson(canonicalIds(plan.associationBatchIds)) !==
      canonicalJson(plan.associationBatchIds)
  ) {
    throw new TypeError('review plan IDs are not canonical and unique')
  }
  const canonicalLimitations = [...plan.limitations]
    .filter(
      (item, index, all) =>
        all.findIndex(other => canonicalJson(other) === canonicalJson(item)) === index,
    )
    .sort(compareCanonical)
  if (canonicalJson(canonicalLimitations) !== canonicalJson(plan.limitations)) {
    throw new TypeError('review plan limitations are not canonical and unique')
  }
  const canonicalSessions = [...plan.sessions]
    .map(session => ({ ...session, triggerIds: canonicalIds(session.triggerIds) }))
    .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey))
  if (canonicalJson(canonicalSessions) !== canonicalJson(plan.sessions)) {
    throw new TypeError('review plan Session ranges are not canonical and unique')
  }
  if (
    canonicalJson(plan.limits) !==
    canonicalJson(
      effectiveLimits({
        maxBundleBytes: plan.limits.maxBundleBytes,
        maxSessions: plan.limits.maxSessions,
      }),
    )
  ) {
    throw new TypeError('review plan limits exceed safe built-in ceilings')
  }
}

function compactPlan(plan: ReviewPlan): ReviewPlanRecord {
  const compact: ReviewPlanRecord = {
    schemaVersion: 1,
    status: plan.status,
    subject:
      plan.subject.kind === 'workspace'
        ? {
            kind: 'workspace',
            repositoryId: plan.subject.observation.repositoryId,
            observationId: plan.subject.observation.observationId,
          }
        : {
            kind: 'pull-request',
            provider: 'github',
            repositoryKey: plan.subject.observation.repositoryKey,
            number: plan.subject.observation.number,
            observationId: plan.subject.observation.observationId,
          },
    subjectFingerprint: plan.subjectFingerprint,
    subjectAttempt: plan.subjectAttempt,
    subjectReview: plan.subjectReview,
    replayCoveredEvidence: plan.replayCoveredEvidence,
    ...(plan.fullReviewReason === undefined ? {} : { fullReviewReason: plan.fullReviewReason }),
    sessions: plan.sessions,
    selections: plan.selections,
    sessionWatermarks: plan.sessionWatermarks,
    coverageTargetWatermarks: plan.coverageTargetWatermarks,
    triggerIds: plan.triggerIds,
    associationBatchIds: plan.associationBatchIds,
    ...(plan.priorLedger === undefined
      ? {}
      : { priorLedger: { path: plan.priorLedger.path, object: plan.priorLedger.object } }),
    limitations: plan.limitations,
    policies: plan.policies,
    limits: plan.limits,
  }
  validateReviewPlanRecord(compact)
  return compact
}

export type BundleVerification =
  | { valid: true; sha256: string; manifest: ReviewBundleManifest }
  | { valid: false; reason: string }

export interface ReviewObjectSource {
  getObject(ref: ObjectRef): Promise<Uint8Array>
}

function addPortableRecord(
  records: Map<string, Uint8Array>,
  path: string,
  value: unknown,
  jsonl = false,
): void {
  const bytes = new TextEncoder().encode(
    jsonl
      ? (value as readonly unknown[]).map(item => canonicalJson(item)).join('')
      : canonicalJson(value),
  )
  const prior = records.get(path)
  if (prior !== undefined && sha256(prior) !== sha256(bytes)) {
    throw new TypeError(`bundle record path has conflicting bytes: ${path}`)
  }
  records.set(path, bytes)
}

function portableRecords(plan: ReviewPlan): Map<string, Uint8Array> {
  const records = new Map<string, Uint8Array>()
  const subject = plan.subject
  if (subject.kind === 'workspace') {
    const path = makeOwnedPath('repository-observations', [
      `${subject.observation.observationId}.json`,
    ])
    validatePublicRecord(path, subject.observation)
    addPortableRecord(records, path, subject.observation)
  } else {
    const path = makeOwnedPath('pull-requests', [
      'github',
      subject.observation.repositoryKey,
      String(subject.observation.number),
      'observations',
      `${subject.observation.observationId}.json`,
    ])
    validatePublicRecord(path, subject.observation)
    addPortableRecord(records, path, subject.observation)
  }
  for (const candidate of plan.evidence) {
    if (
      candidate.trigger.turnId !== candidate.turn.turnId ||
      candidate.trigger.sessionKey !== candidate.turn.sessionKey ||
      candidate.trigger.repositoryObservationId !== candidate.turn.repositoryObservationId
    ) {
      throw new TypeError('review evidence contains a mismatched trigger/Turn join')
    }
    const root = [
      candidate.trigger.provider,
      candidate.trigger.sessionKey,
      'turns',
      candidate.turn.turnId,
    ]
    const turnPath = makeOwnedPath('sessions', [...root, 'manifest.json'])
    const identityPath = makeOwnedPath('sessions', [
      candidate.trigger.provider,
      candidate.trigger.sessionKey,
      'identity.json',
    ])
    const triggerPath = makeOwnedPath('review-triggers', [`${candidate.trigger.triggerId}.json`])
    validatePublicRecord(turnPath, candidate.turn)
    validatePublicRecord(identityPath, candidate.identity)
    validatePublicRecord(triggerPath, candidate.trigger)
    addPortableRecord(records, turnPath, candidate.turn)
    addPortableRecord(records, identityPath, candidate.identity)
    addPortableRecord(records, triggerPath, candidate.trigger)
    if (candidate.events !== undefined) {
      const path = makeOwnedPath('sessions', [...root, 'events.jsonl'])
      candidate.events.forEach(event => validatePublicRecord(path, event))
      addPortableRecord(records, path, candidate.events, true)
    }
    if (candidate.transcript !== undefined) {
      const path = makeOwnedPath('sessions', [...root, 'transcript.jsonl'])
      candidate.transcript.forEach(event => validatePublicRecord(path, event))
      addPortableRecord(records, path, candidate.transcript, true)
    }
    if (candidate.repositoryObservation !== undefined) {
      if (
        candidate.repositoryObservation.observationId !== candidate.turn.repositoryObservationId
      ) {
        throw new TypeError('Turn does not join its supplied repository observation')
      }
      const path = makeOwnedPath('repository-observations', [
        `${candidate.repositoryObservation.observationId}.json`,
      ])
      validatePublicRecord(path, candidate.repositoryObservation)
      addPortableRecord(records, path, candidate.repositoryObservation)
    }
  }
  if (subject.kind === 'pull-request') {
    for (const group of plan.associations) {
      if (!verifyAssociationBatch(group.batch, subject.observation, group.evidence)) {
        throw new TypeError('review plan contains an invalid association completion batch')
      }
      const root = [
        'github',
        subject.observation.repositoryKey,
        String(subject.observation.number),
        'associations',
        subject.observation.observationId,
      ]
      for (const evidence of group.evidence) {
        const path = makeOwnedPath('pull-requests', [...root, `${evidence.evidenceId}.json`])
        validatePublicRecord(path, evidence)
        addPortableRecord(records, path, evidence)
      }
      const path = makeOwnedPath('pull-requests', [
        ...root,
        'batches',
        `${group.batch.batchId}.json`,
      ])
      validatePublicRecord(path, group.batch)
      addPortableRecord(records, path, group.batch)
    }
  }
  if (plan.priorLedger !== undefined) {
    validatePublicRecord(plan.priorLedger.path, plan.priorLedger.ledger)
    addPortableRecord(records, plan.priorLedger.path, plan.priorLedger.ledger)
  }
  return new Map([...records].sort(([left], [right]) => left.localeCompare(right)))
}

async function expandInventory(
  plan: ReviewPlan,
  source: ReviewObjectSource,
): Promise<{ bytes: Map<string, Uint8Array>; refs: ObjectRef[] }> {
  const pending = [...plan.objectInventory]
  const bytesByHash = new Map<string, Uint8Array>()
  const refs = new Map<string, ObjectRef>()
  let aggregateBytes = 0
  while (pending.length > 0) {
    const ref = pending.shift()!
    refs.set(canonicalJson(ref), ref)
    let bytes = bytesByHash.get(ref.sha256)
    if (bytes === undefined) {
      bytes =
        plan.priorLedger?.object.sha256 === ref.sha256
          ? new TextEncoder().encode(canonicalJson(plan.priorLedger.ledger))
          : await source.getObject(ref)
      if (bytes.byteLength !== ref.bytes || sha256(bytes) !== ref.sha256) {
        throw new Error(`bundle object failed verification: ${ref.sha256}`)
      }
      bytesByHash.set(ref.sha256, bytes)
      aggregateBytes += bytes.byteLength
      if (bytesByHash.size > plan.limits.maxObjects)
        throw new Error('bundle exceeds object-count bound')
      if (aggregateBytes > plan.limits.maxBundleBytes)
        throw new Error('bundle exceeds aggregate byte bound')
    } else if (bytes.byteLength !== ref.bytes) {
      throw new Error(`bundle object has conflicting lengths: ${ref.sha256}`)
    }
    if (
      ref.mediaType === 'application/vnd.factory.code-manifest+json' &&
      ref.role === 'workspace-code-manifest'
    ) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (canonicalJson(JSON.parse(text)) !== text)
        throw new Error('code manifest is not canonical')
      const manifest = parseCodeManifest(JSON.parse(text))
      const nested = new Map<string, ObjectRef>()
      collectObjectRefs(manifest, nested)
      pending.push(...nested.values())
    }
  }
  return {
    bytes: bytesByHash,
    refs: [...refs.values()].sort(compareCanonical),
  }
}

function bundleDigest(manifest: ReviewBundleManifest): string {
  return sha256(canonicalJson(manifest))
}

/** Build a directory bundle whose verification never consults the source repository or Git. */
export async function buildBundle(
  plan: ReviewPlan,
  source: ReviewObjectSource,
  destination: string,
): Promise<{ path: string; sha256: string }> {
  if (plan.status !== 'ready') throw new TypeError('only a ready review plan can become a bundle')
  validateReviewPlanRecord(compactPlan(plan))
  const objects = await expandInventory(plan, source)
  const recordBytes = portableRecords(plan)
  let aggregateBytes = [...objects.bytes.values()].reduce(
    (total, bytes) => total + bytes.byteLength,
    0,
  )
  for (const bytes of recordBytes.values()) {
    if (bytes.byteLength > plan.limits.maxStructuredRecordBytes)
      throw new Error('bundle structured record exceeds byte bound')
    aggregateBytes += bytes.byteLength
  }
  if (recordBytes.size + objects.bytes.size > plan.limits.maxFiles)
    throw new Error('bundle exceeds file-count bound')
  if (aggregateBytes > plan.limits.maxBundleBytes)
    throw new Error('bundle exceeds aggregate byte bound')
  const objectFiles = [...objects.bytes].map(([hash, bytes]) => ({
    path: `.factory/${objectOwnedPath(hash)}`,
    kind: 'object' as const,
    sha256: hash,
    bytes: bytes.byteLength,
  }))
  const recordFiles = [...recordBytes].map(([path, bytes]) => ({
    path: `.factory/${path}`,
    kind: 'record' as const,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  }))
  const files = [...recordFiles, ...objectFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
  const manifest: ReviewBundleManifest = {
    schemaVersion: 1,
    format: 'factory-review-bundle',
    plan: compactPlan(plan),
    inventory: objects.refs,
    files,
  }
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest))
  if (manifestBytes.byteLength > plan.limits.maxStructuredRecordBytes)
    throw new Error('bundle manifest exceeds structured-record byte bound')
  if (aggregateBytes + manifestBytes.byteLength > plan.limits.maxBundleBytes)
    throw new Error('bundle exceeds aggregate byte bound')
  await mkdir(destination, { recursive: false })
  for (const [path, bytes] of recordBytes) {
    const output = join(destination, '.factory', path)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, bytes, { flag: 'wx', mode: 0o444 })
  }
  for (const [hash, bytes] of objects.bytes) {
    const path = join(destination, '.factory', objectOwnedPath(hash))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { flag: 'wx', mode: 0o444 })
  }
  await writeFile(join(destination, 'bundle.json'), manifestBytes, {
    flag: 'wx',
    mode: 0o444,
  })
  const digest = bundleDigest(manifest)
  const verification = await verifyBundle(destination, digest)
  if (!verification.valid)
    throw new Error(`built bundle failed verification: ${verification.reason}`)
  return { path: destination, sha256: digest }
}

/** Verify a copied bundle in a fresh directory; `.git` and `.factory` are neither read nor needed. */
const splitPortablePath = (path: string) =>
  path.split('/').map(segment => new TextEncoder().encode(segment))

export async function verifyBundle(
  path: string,
  expectedSha256: string,
): Promise<BundleVerification> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      await readConfinedFile(path, [new TextEncoder().encode('bundle.json')], {
        maximumBytes: 4 * 1024 * 1024,
      }),
    )
    const manifest = JSON.parse(text) as ReviewBundleManifest
    if (
      canonicalJson(manifest) !== text ||
      manifest.schemaVersion !== 1 ||
      manifest.format !== 'factory-review-bundle'
    ) {
      throw new Error('bundle manifest is invalid or noncanonical')
    }
    validateReviewPlanRecord(manifest.plan)
    if (
      canonicalJson(manifest.plan.limits) !==
      canonicalJson(
        effectiveLimits({
          maxBundleBytes: manifest.plan.limits.maxBundleBytes,
          maxSessions: manifest.plan.limits.maxSessions,
        }),
      )
    ) {
      throw new Error('bundle limits exceed safe built-in ceilings')
    }
    const canonicalInventory = [...manifest.inventory].sort(compareCanonical)
    if (
      canonicalJson(canonicalInventory) !== canonicalJson(manifest.inventory) ||
      new Set(manifest.inventory.map(ref => canonicalJson(ref))).size !== manifest.inventory.length
    ) {
      throw new Error('bundle object inventory is not canonical and unique')
    }
    const canonicalFiles = [...manifest.files].sort(
      (left, right) => left.path.localeCompare(right.path) || compareCanonical(left, right),
    )
    if (canonicalJson(canonicalFiles) !== canonicalJson(manifest.files)) {
      throw new Error('bundle file inventory is not canonical')
    }
    const digest = bundleDigest(manifest)
    if (digest !== expectedSha256) throw new Error('bundle digest differs')
    const expectedPaths = new Set(manifest.files.map(file => file.path))
    if (expectedPaths.size !== manifest.files.length)
      throw new Error('bundle inventory has duplicate paths')
    const actualEntries = await inventoryConfinedTree(path, {
      maximumEntries: manifest.plan.limits.maxFiles,
      maximumFileBytes: manifest.plan.limits.maxBundleBytes,
      maximumBytes: manifest.plan.limits.maxBundleBytes,
      maximumDepth: manifest.plan.limits.maxDepth,
    })
    if (actualEntries.some(entry => entry.kind === 'symlink'))
      throw new Error('bundle refuses symbolic links')
    const expectedEntries = new Map<string, 'directory' | 'file'>([['bundle.json', 'file']])
    for (const filePath of expectedPaths) {
      expectedEntries.set(filePath, 'file')
      const segments = filePath.split('/')
      for (let index = 1; index < segments.length; index += 1) {
        expectedEntries.set(segments.slice(0, index).join('/'), 'directory')
      }
    }
    const expectedTree = [...expectedEntries].sort(([left], [right]) => left.localeCompare(right))
    const actualTree = actualEntries
      .map(entry => [entry.path, entry.kind] as const)
      .sort(([left], [right]) => left.localeCompare(right))
    if (canonicalJson(expectedTree) !== canonicalJson(actualTree)) {
      throw new Error('bundle contains missing or undeclared files')
    }
    manifest.inventory.forEach(validateObjectRef)
    const inventoryHashes = new Set(manifest.inventory.map(ref => ref.sha256))
    const objectHashes = new Set(
      manifest.files.filter(file => file.kind === 'object').map(file => file.sha256),
    )
    for (const hash of inventoryHashes) {
      if (!objectHashes.has(hash)) throw new Error('bundle omits a transitive object')
    }
    if ([...objectHashes].some(hash => !inventoryHashes.has(hash))) {
      throw new Error('bundle object files differ from transitive inventory')
    }
    const recordValues = new Map<string, unknown[]>()
    const recordBytes = new Map<string, Uint8Array>()
    for (const file of manifest.files) {
      if (file.kind === 'object' && file.path !== `.factory/${objectOwnedPath(file.sha256)}`)
        throw new Error('bundle object path is invalid')
      const bytes = await readConfinedFile(path, splitPortablePath(file.path), {
        maximumBytes:
          file.kind === 'record'
            ? manifest.plan.limits.maxStructuredRecordBytes
            : manifest.plan.limits.maxBundleBytes,
      })
      if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new Error(`bundle object failed verification: ${file.path}`)
      }
      if (file.kind === 'record') {
        const ownedPath = file.path.replace(/^\.factory\//, '')
        const values = ownedPath.endsWith('.jsonl')
          ? decodeCanonicalJsonl(ownedPath, bytes)
          : [decodeCanonicalRecord(ownedPath, bytes)]
        recordValues.set(ownedPath, values)
        recordBytes.set(ownedPath, bytes)
      }
    }
    const referenced = new Map<string, ObjectRef>()
    collectObjectRefs([...recordValues.values()], referenced)
    if (manifest.plan.priorLedger !== undefined)
      collectObjectRefs(manifest.plan.priorLedger.object, referenced)
    for (const ref of referenced.values()) {
      if (!manifest.inventory.some(item => canonicalJson(item) === canonicalJson(ref))) {
        throw new Error(`bundle inventory omits referenced object: ${ref.sha256}`)
      }
    }
    const subjectPath =
      manifest.plan.subject.kind === 'workspace'
        ? `repository-observations/${manifest.plan.subject.observationId}.json`
        : `pull-requests/github/${manifest.plan.subject.repositoryKey}/${manifest.plan.subject.number}/observations/${manifest.plan.subject.observationId}.json`
    if (!recordValues.has(subjectPath)) throw new Error('bundle omits its subject observation')
    const bundledSubject: ReviewSubject =
      manifest.plan.subject.kind === 'workspace'
        ? {
            kind: 'workspace',
            observation: recordValues.get(subjectPath)![0] as RepositoryObservation,
          }
        : {
            kind: 'pull-request',
            observation: recordValues.get(subjectPath)![0] as AvailablePullRequestObservation,
          }
    if (subjectFingerprint(bundledSubject) !== manifest.plan.subjectFingerprint) {
      throw new Error('bundle subject fingerprint differs from its subject bytes')
    }
    if (manifest.plan.subject.kind === 'pull-request') {
      const observation = recordValues.get(subjectPath)?.[0] as AvailablePullRequestObservation
      const associationRoot = `pull-requests/github/${manifest.plan.subject.repositoryKey}/${manifest.plan.subject.number}/associations/${manifest.plan.subject.observationId}`
      const namedEvidence = new Set<string>()
      for (const batchId of manifest.plan.associationBatchIds) {
        const batchPath = `${associationRoot}/batches/${batchId}.json`
        const batch = recordValues.get(batchPath)?.[0] as AssociationBatch | undefined
        if (batch === undefined) throw new Error('bundle omits a completed association batch')
        const evidence = batch.evidence.map(reference => {
          namedEvidence.add(reference.evidenceId)
          const value = recordValues.get(`${associationRoot}/${reference.evidenceId}.json`)?.[0]
          if (value === undefined) throw new Error('bundle omits batch-named association evidence')
          return value as SessionPullRequestAssociation
        })
        if (!verifyAssociationBatch(batch, observation, evidence)) {
          throw new Error('bundle association completion batch is invalid')
        }
      }
      for (const recordPath of recordValues.keys()) {
        if (!recordPath.startsWith(`${associationRoot}/`) || recordPath.includes('/batches/'))
          continue
        const evidenceId = recordPath.slice(associationRoot.length + 1, -'.json'.length)
        if (!namedEvidence.has(evidenceId))
          throw new Error('bundle contains orphan association evidence')
      }
    }
    const compactWorkspaceRepositoryId =
      manifest.plan.subject.kind === 'workspace' ? manifest.plan.subject.repositoryId : undefined
    for (const selection of manifest.plan.selections) {
      if (!selection.selectedForReview) continue
      if (selection.kind !== 'range')
        throw new Error('bundle cannot include an opaque problem as readable evidence')
      const triggerPath = `review-triggers/${selection.triggerId}.json`
      const trigger = recordValues.get(triggerPath)?.[0] as ReviewTrigger | undefined
      if (
        trigger === undefined ||
        trigger.sessionKey !== selection.sessionKey ||
        trigger.turnId !== selection.turnId ||
        trigger.evidenceWatermark !== selection.evidenceWatermark
      ) {
        throw new Error('bundle selection does not join its trigger record')
      }
      const loaded = await loadCandidateEvidence(
        {
          read: async ownedPath => {
            const bytes = recordBytes.get(ownedPath)
            return bytes === undefined
              ? { kind: 'missing', detail: `bundle omits ${ownedPath}` }
              : { kind: 'readable', bytes }
          },
          getObject: async ref => {
            try {
              return {
                kind: 'readable',
                bytes: await readConfinedFile(
                  path,
                  splitPortablePath(`.factory/${objectOwnedPath(ref.sha256)}`),
                  { maximumBytes: manifest.plan.limits.maxBundleBytes },
                ),
              }
            } catch (error) {
              return {
                kind: 'unsafe',
                detail: error instanceof Error ? error.message : String(error),
              }
            }
          },
        },
        {
          triggerId: selection.triggerId,
          scopeProof:
            compactWorkspaceRepositoryId !== undefined
              ? {
                  kind: 'workspace-store',
                  repositoryId: compactWorkspaceRepositoryId,
                }
              : { kind: 'diagnostic-only' },
        },
      )
      if (!('trigger' in loaded))
        throw new Error(`bundle selected evidence is ${loaded.availability}`)
    }
    return { valid: true, sha256: digest, manifest }
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
