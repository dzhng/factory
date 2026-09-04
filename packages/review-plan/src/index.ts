import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { verifyTurnEvidenceGraph } from '@factory/capture'
import {
  assertOwnedRecordPath,
  canonicalJson,
  makeOwnedPath,
  objectOwnedPath,
  parseCodeManifest,
  reviewSubjectCoverageId,
  reviewInputProblemId,
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
  type ReviewManifest,
  type ReviewInputProblem,
  type ReviewEvidenceSelection as ContractReviewEvidenceSelection,
  type ReviewerSettings,
  type ReviewTrigger,
  type SessionPullRequestAssociation,
  type TurnManifest,
} from '@factory/contract'
import { verifyAssociationBatch } from '@factory/github'
import {
  inventoryConfinedTree,
  loadCodeManifestObject,
  readConfinedFile,
} from '@factory/repository'

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

export interface ReviewRepositoryReader extends PortableRecordReader {
  /** One bounded descriptor-confined snapshot of every immutable owned record path. */
  inventory(): Promise<readonly OwnedPath[]>
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
    await verifyTurnEvidenceGraph(candidate, async reference => {
      const result = await reader.getObject(reference)
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
      return result.bytes
    })
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
  inputProblems: readonly ReviewInputProblem[]
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

export type ReviewHistoryDescriptor = {
  manifestPath: OwnedPath
}

export type LoadedHistorySource = {
  path: OwnedPath
  bytes: Uint8Array
  sha256: string
  kind: 'review-manifest' | 'review-ledger' | 'coverage-action' | 'subject-observation'
}

function historySourceKind(path: OwnedPath): LoadedHistorySource['kind'] | undefined {
  if (/^reviews\/coverage-actions\/[^/]+\.json$/.test(path)) return 'coverage-action'
  if (/^reviews\/.+\/manifest\.json$/.test(path)) return 'review-manifest'
  if (/^reviews\/.+\/ledger\.json$/.test(path)) return 'review-ledger'
  if (
    /^repository-observations\/[^/]+\.json$/.test(path) ||
    /^pull-requests\/github\/[^/]+\/\d+\/observations\/[^/]+\.json$/.test(path)
  )
    return 'subject-observation'
  return undefined
}

type LoadedReviewHistoryState = {
  reviews: readonly PriorReview[]
  coverageActions: readonly CoverageAction[]
  sources: readonly LoadedHistorySource[]
}

declare const loadedReviewHistoryBrand: unique symbol
export type LoadedReviewHistory = { readonly [loadedReviewHistoryBrand]: true }
const loadedHistories = new WeakMap<object, LoadedReviewHistoryState>()

export type ReviewHistoryLoadRequest = {
  reviews: readonly ReviewHistoryDescriptor[]
  coverageActionPaths: readonly OwnedPath[]
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
  /** Internal/testing seam; public callers receive this from loadReviewHistory. */
  historySources?: readonly LoadedHistorySource[]
  subjectLimitations?: readonly Limitation[]
  subjectObjectRefs?: readonly ObjectRef[]
  inputProblems?: readonly ReviewInputProblem[]
}

declare const loadedReviewInputsBrand: unique symbol
export type LoadedReviewInputs = { readonly [loadedReviewInputsBrand]: true }
const loadedReviewInputs = new WeakMap<object, ReviewInputs>()

export type ReviewInputLoadRequest = {
  mode: ReviewInputs['mode']
  subjectPath: OwnedPath
  history: LoadedReviewHistory
  policies: ReviewPolicies
  sessionKey?: string
  reviewLimits?: ReviewInputs['reviewLimits']
}

export type EffectiveReviewLimits = {
  maxBundleBytes: number
  maxSessions: number
  maxTreeEntries: number
  maxObjects: number
  maxDepth: number
  maxStructuredRecordBytes: number
}

export type CoverageView = {
  settledWatermarks: Readonly<Record<string, number>>
  reviewedWatermarks: Readonly<Record<string, readonly number[]>>
  acceptedTriggerIds: readonly RecordId[]
  acceptedProblemIds: readonly string[]
  priorSelections: Readonly<Record<string, ReviewEvidenceSelection>>
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
  historySources: readonly LoadedHistorySource[]
  inputProblems: readonly ReviewInputProblem[]
}

function effectiveLimits(configured: ReviewInputs['reviewLimits']): EffectiveReviewLimits {
  const clamp = (value: number | undefined, fallback: number, ceiling: number): number =>
    value === undefined || !Number.isSafeInteger(value) || value <= 0
      ? fallback
      : Math.min(value, ceiling)
  return {
    maxBundleBytes: clamp(configured?.maxBundleBytes, 256 * 1024 * 1024, 512 * 1024 * 1024),
    maxSessions: clamp(configured?.maxSessions, 100, 1_000),
    maxTreeEntries: 200_000,
    maxObjects: 100_000,
    maxDepth: 16,
    maxStructuredRecordBytes: 4 * 1024 * 1024,
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function verifyCodeManifestClosure(
  reference: ObjectRef,
  getObject: (reference: ObjectRef) => Promise<Uint8Array>,
): Promise<readonly Limitation[]> {
  const manifest = await loadCodeManifestObject(reference, getObject)
  const references = new Map<string, ObjectRef>()
  collectObjectRefs(manifest, references)
  for (const nested of references.values()) await getObject(nested)
  return manifest.limitations
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

async function readRequiredRecord(
  reader: PortableRecordReader,
  path: OwnedPath,
): Promise<{ value: unknown; bytes: Uint8Array }> {
  const result = await reader.read(path)
  if (result.kind !== 'readable')
    throw new Error(`history ${result.kind}: ${path}: ${result.detail}`)
  const bytes = new Uint8Array(result.bytes)
  return { value: decodeCanonicalRecord(path, bytes), bytes }
}

/** Load restart-safe review history only from validated immutable repository bytes. */
export async function loadReviewHistory(
  reader: PortableRecordReader,
  request: ReviewHistoryLoadRequest,
): Promise<LoadedReviewHistory> {
  const reviewDescriptors = [...request.reviews].sort((left, right) =>
    left.manifestPath.localeCompare(right.manifestPath),
  )
  if (
    new Set(reviewDescriptors.map(item => item.manifestPath)).size !== reviewDescriptors.length ||
    new Set(request.coverageActionPaths).size !== request.coverageActionPaths.length
  ) {
    throw new TypeError('review history descriptors must be unique')
  }
  const reviews: PriorReview[] = []
  const sources: LoadedHistorySource[] = []
  const reviewIds = new Set<string>()
  for (const descriptor of reviewDescriptors) {
    const manifestRecord = await readRequiredRecord(reader, descriptor.manifestPath)
    const manifest = manifestRecord.value as ReviewManifest
    if (reviewIds.has(manifest.reviewId)) throw new TypeError('review IDs must be globally unique')
    reviewIds.add(manifest.reviewId)
    sources.push({
      path: descriptor.manifestPath,
      bytes: manifestRecord.bytes,
      sha256: sha256(manifestRecord.bytes),
      kind: 'review-manifest',
    })
    const subjectPath =
      manifest.subject.kind === 'workspace'
        ? makeOwnedPath('repository-observations', [
            `${manifest.subject.repositoryObservationId}.json`,
          ])
        : makeOwnedPath('pull-requests', [
            manifest.subject.provider,
            manifest.subject.repositoryKey,
            String(manifest.subject.number),
            'observations',
            `${manifest.subject.observationId}.json`,
          ])
    const subjectSource = await readRequiredRecord(reader, subjectPath)
    const subjectRecord = subjectSource.value
    sources.push({
      path: subjectPath,
      bytes: subjectSource.bytes,
      sha256: sha256(subjectSource.bytes),
      kind: 'subject-observation',
    })
    const subject: ReviewSubject =
      manifest.subject.kind === 'workspace'
        ? { kind: 'workspace', observation: subjectRecord as RepositoryObservation }
        : {
            kind: 'pull-request',
            observation: subjectRecord as AvailablePullRequestObservation,
          }
    if (subjectFingerprint(subject) !== manifest.subjectFingerprint) {
      throw new TypeError('history review fingerprint differs from its exact subject bytes')
    }
    for (const problem of manifest.inputProblems) {
      if (problem.kind === 'association-batch') {
        if (
          subject.kind !== 'pull-request' ||
          !problem.path.startsWith(
            `pull-requests/github/${subject.observation.repositoryKey}/${subject.observation.number}/associations/${subject.observation.observationId}/batches/`,
          )
        ) {
          throw new TypeError('history association problem is detached from its exact PR subject')
        }
        continue
      }
      const directReference = (() => {
        if (problem.field === 'codeManifest') return subject.observation.codeManifest
        if (subject.kind === 'workspace') {
          if (problem.field === 'stagedPatch') return subject.observation.stagedPatch
          if (problem.field === 'unstagedPatch') return subject.observation.unstagedPatch
        } else if (problem.field === 'raw') {
          return subject.observation.raw.find(
            reference => canonicalJson(reference) === canonicalJson(problem.object),
          )
        }
        if (problem.field === 'limitation') {
          return subject.observation.limitations
            .map(limitation => limitation.object)
            .find(reference => canonicalJson(reference) === canonicalJson(problem.object))
        }
        return undefined
      })()
      if (
        directReference === undefined &&
        !(problem.field === 'limitation' && manifest.codeManifest !== undefined)
      ) {
        throw new TypeError('history subject object problem is detached from its subject')
      }
      if (
        directReference !== undefined &&
        canonicalJson(directReference) !== canonicalJson(problem.object)
      ) {
        throw new TypeError('history subject object problem names another object')
      }
    }
    let ledger: ReviewLedger | undefined
    const ledgerPath = descriptor.manifestPath.endsWith('/manifest.json')
      ? makeOwnedPath(
          'reviews',
          descriptor.manifestPath
            .slice('reviews/'.length, -'/manifest.json'.length)
            .split('/')
            .concat('ledger.json'),
        )
      : undefined
    if (ledgerPath === undefined)
      throw new TypeError('review manifest path must end in manifest.json')
    const ledgerRead = await reader.read(ledgerPath)
    if (manifest.disposition === 'failed') {
      if (ledgerRead.kind === 'readable')
        throw new TypeError('failed history review must not have a ledger')
      if (ledgerRead.kind !== 'missing') throw new TypeError('failed history ledger path is unsafe')
    } else {
      if (ledgerRead.kind !== 'readable')
        throw new Error(`history ${ledgerRead.kind}: ${ledgerPath}: ${ledgerRead.detail}`)
      ledger = decodeCanonicalRecord(ledgerPath, ledgerRead.bytes) as ReviewLedger
      if (ledger.reviewId !== manifest.reviewId)
        throw new TypeError('history ledger names another review')
      sources.push({
        path: ledgerPath,
        bytes: ledgerRead.bytes,
        sha256: sha256(ledgerRead.bytes),
        kind: 'review-ledger',
      })
    }
    reviews.push({
      reviewId: manifest.reviewId,
      subject,
      subjectFingerprint: manifest.subjectFingerprint,
      subjectAttempt: manifest.subjectAttempt,
      sessionWatermarks: manifest.sessionWatermarks,
      coverageTargetWatermarks: manifest.coverageTargetWatermarks,
      selections: manifest.evidenceSelections,
      inputProblems: manifest.inputProblems,
      triggerIds: manifest.triggerIds,
      disposition: manifest.disposition,
      policies: {
        reviewer: manifest.reviewer,
        analyzerVersion: manifest.analyzerVersion,
        promptVersion: manifest.promptVersion,
        policyVersion: manifest.policyVersion,
        formatVersion: manifest.formatVersion,
      },
      ...(manifest.head === undefined ? {} : { head: manifest.head }),
      ...(manifest.codeManifest === undefined ? {} : { codeManifest: manifest.codeManifest }),
      ...(ledger === undefined ? {} : { ledger }),
    })
  }
  const actionRecords = await Promise.all(
    [...request.coverageActionPaths]
      .sort()
      .map(async path => ({ path, record: await readRequiredRecord(reader, path) })),
  )
  const actions = actionRecords.map(item => item.record.value as CoverageAction)
  sources.push(
    ...actionRecords.map(item => ({
      path: item.path,
      bytes: item.record.bytes,
      sha256: sha256(item.record.bytes),
      kind: 'coverage-action' as const,
    })),
  )
  const reviewsById = new Map(reviews.map(review => [review.reviewId, review]))
  for (const action of actions) {
    const review = reviewsById.get(action.reviewId)
    if (review === undefined || review.disposition !== 'partial') {
      throw new TypeError('history coverage action does not join a partial review')
    }
  }
  const sourcesByPath = new Map<OwnedPath, LoadedHistorySource>()
  for (const source of sources) {
    const prior = sourcesByPath.get(source.path)
    if (prior !== undefined && prior.sha256 !== source.sha256)
      throw new TypeError('history path has conflicting immutable bytes')
    sourcesByPath.set(source.path, source)
  }
  const state: LoadedReviewHistoryState = {
    reviews,
    coverageActions: actions,
    sources: [...sourcesByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
  }
  const history = Object.freeze({}) as LoadedReviewHistory
  loadedHistories.set(history, state)
  return history
}

/** Load and defensively freeze every repository-owned input before planning. */
export async function loadReviewInputs(
  reader: ReviewRepositoryReader,
  request: ReviewInputLoadRequest,
): Promise<LoadedReviewInputs> {
  const history = loadedHistories.get(request.history)
  if (history === undefined)
    throw new TypeError('review history was not produced by loadReviewHistory')
  const inventory = [...(await reader.inventory())]
  if (inventory.length > 200_000) throw new TypeError('review repository inventory exceeds bound')
  inventory.forEach(assertOwnedRecordPath)
  const canonicalInventory = [...inventory].sort()
  if (
    new Set(inventory).size !== inventory.length ||
    canonicalJson(canonicalInventory) !== canonicalJson(inventory)
  )
    throw new TypeError('review repository inventory must be canonical and unique')
  const subjectRecord = (await readRequiredRecord(reader, request.subjectPath)).value
  const subject: ReviewSubject = request.subjectPath.startsWith('repository-observations/')
    ? { kind: 'workspace', observation: subjectRecord as RepositoryObservation }
    : request.subjectPath.startsWith('pull-requests/github/')
      ? { kind: 'pull-request', observation: subjectRecord as AvailablePullRequestObservation }
      : (() => {
          throw new TypeError('review subject path has an unsupported lineage')
        })()
  const readSubjectObject = async (reference: ObjectRef): Promise<Uint8Array> => {
    const result = await reader.getObject(reference)
    if (result.kind !== 'readable')
      throw new Error(`foundational subject object is ${result.kind}: ${result.detail}`)
    if (result.bytes.byteLength !== reference.bytes || sha256(result.bytes) !== reference.sha256)
      throw new Error(`foundational subject object is corrupt: ${reference.sha256}`)
    return result.bytes
  }
  let subjectLimitations: readonly Limitation[] = subject.observation.limitations
  const subjectObjectRefs: ObjectRef[] = []
  const inputProblems: ReviewInputProblem[] = []
  const subjectObjectProblem = (
    field: Extract<ReviewInputProblem, { kind: 'subject-object' }>['field'],
    object: ObjectRef,
    error: unknown,
  ): Limitation => {
    const detail = error instanceof Error ? error.message : String(error)
    const classification = detail.includes(' is unsafe:')
      ? 'unsafe'
      : detail.includes(' is missing:')
        ? 'unavailable'
        : detail.includes('excluded-by-limit')
          ? 'excluded'
          : 'corrupt'
    const limitation: Limitation = {
      code: classification === 'corrupt' ? 'corrupt-input' : 'unverified-object',
      detail: `optional subject ${field} unavailable: ${detail}`,
    }
    const problem = {
      kind: 'subject-object',
      field,
      object,
      classification,
      limitation,
    } as const
    inputProblems.push({ ...problem, problemId: reviewInputProblemId(problem) })
    return limitation
  }
  if (subject.kind === 'workspace') {
    if (subject.observation.codeManifest === undefined)
      throw new Error('workspace review requires a foundational code manifest')
    const codeManifest = await loadCodeManifestObject(
      subject.observation.codeManifest,
      readSubjectObject,
    )
    subjectLimitations = [...subjectLimitations, ...codeManifest.limitations]
    for (const entry of codeManifest.entries)
      if ('object' in entry) await readSubjectObject(entry.object)
    const codeRefs = new Map<string, ObjectRef>()
    collectObjectRefs(codeManifest, codeRefs)
    const entryRefs = new Set(
      codeManifest.entries
        .filter(
          (entry): entry is Extract<(typeof codeManifest.entries)[number], { object: ObjectRef }> =>
            'object' in entry,
        )
        .map(entry => canonicalJson(entry.object)),
    )
    for (const reference of codeRefs.values()) {
      if (entryRefs.has(canonicalJson(reference))) continue
      try {
        await readSubjectObject(reference)
      } catch (error) {
        subjectLimitations = [
          ...subjectLimitations,
          subjectObjectProblem('limitation', reference, error),
        ]
      }
    }
    subjectObjectRefs.push(subject.observation.codeManifest)
    for (const reference of [subject.observation.stagedPatch, subject.observation.unstagedPatch])
      if (reference !== undefined) {
        try {
          await readSubjectObject(reference)
          subjectObjectRefs.push(reference)
        } catch (error) {
          subjectLimitations = [
            ...subjectLimitations,
            subjectObjectProblem(
              reference === subject.observation.stagedPatch ? 'stagedPatch' : 'unstagedPatch',
              reference,
              error,
            ),
          ]
        }
      }
  } else {
    await readSubjectObject(subject.observation.diff)
    subjectObjectRefs.push(subject.observation.diff)
    for (const reference of subject.observation.raw) {
      try {
        await readSubjectObject(reference)
        subjectObjectRefs.push(reference)
      } catch (error) {
        subjectLimitations = [...subjectLimitations, subjectObjectProblem('raw', reference, error)]
      }
    }
    if (subject.observation.codeManifest !== undefined) {
      try {
        const limitations = await verifyCodeManifestClosure(
          subject.observation.codeManifest,
          readSubjectObject,
        )
        subjectLimitations = [...subjectLimitations, ...limitations]
        subjectObjectRefs.push(subject.observation.codeManifest)
      } catch (error) {
        subjectLimitations = [
          ...subjectLimitations,
          subjectObjectProblem('codeManifest', subject.observation.codeManifest, error),
        ]
      }
    }
  }
  const declaredSubjectRefs = new Map<string, ObjectRef>()
  collectObjectRefs(subject.observation, declaredSubjectRefs)
  const handledSubjectRefs = new Set([
    ...subjectObjectRefs.map(reference => canonicalJson(reference)),
    ...inputProblems
      .filter(
        (problem): problem is Extract<ReviewInputProblem, { kind: 'subject-object' }> =>
          problem.kind === 'subject-object',
      )
      .map(problem => canonicalJson(problem.object)),
  ])
  for (const reference of declaredSubjectRefs.values()) {
    if (handledSubjectRefs.has(canonicalJson(reference))) continue
    try {
      await readSubjectObject(reference)
      subjectObjectRefs.push(reference)
    } catch (error) {
      subjectLimitations = [
        ...subjectLimitations,
        subjectObjectProblem('limitation', reference, error),
      ]
    }
  }
  const candidateTriggerIds = inventory
    .filter(path => /^review-triggers\/[^/]+\.json$/.test(path))
    .map(path => path.slice('review-triggers/'.length, -'.json'.length) as RecordId)
  const associationBatchPaths =
    subject.kind === 'pull-request'
      ? inventory.filter(path =>
          path.startsWith(
            `pull-requests/github/${subject.observation.repositoryKey}/${subject.observation.number}/associations/${subject.observation.observationId}/batches/`,
          ),
        )
      : []
  const candidates: ReviewCandidate[] = await Promise.all(
    candidateTriggerIds.map(triggerId =>
      loadCandidateEvidence(reader, {
        triggerId,
        scopeProof:
          subject.kind === 'workspace'
            ? { kind: 'workspace-store', repositoryId: subject.observation.repositoryId }
            : history.reviews.some(
                  review =>
                    sameSubject(review, subject) &&
                    review.selections.some(selection => selection.triggerId === triggerId),
                )
              ? {
                  kind: 'prior-plan',
                  reviewId: history.reviews.find(
                    review =>
                      sameSubject(review, subject) &&
                      review.selections.some(selection => selection.triggerId === triggerId),
                  )!.reviewId,
                }
              : { kind: 'diagnostic-only' },
      }),
    ),
  )
  const associations: CompletedAssociationGroup[] = []
  if (subject.kind === 'pull-request') {
    for (const batchPath of associationBatchPaths) {
      try {
        const batch = (await readRequiredRecord(reader, batchPath)).value as AssociationBatch
        const markerIndex = batchPath.lastIndexOf('/batches/')
        if (markerIndex < 0) throw new TypeError('association batch path is invalid')
        const root = batchPath.slice(0, markerIndex)
        const evidence = await Promise.all(
          batch.evidence.map(
            async reference =>
              (
                await readRequiredRecord(
                  reader,
                  `${root}/${reference.evidenceId}.json` as OwnedPath,
                )
              ).value as SessionPullRequestAssociation,
          ),
        )
        if (!verifyAssociationBatch(batch, subject.observation, evidence))
          throw new TypeError('association batch does not verify against the exact PR observation')
        associations.push({ batch, evidence })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const classification = detail.startsWith('history missing:')
          ? 'unavailable'
          : detail.startsWith('history unsafe:')
            ? 'unsafe'
            : 'corrupt'
        const limitation: Limitation = {
          code: classification === 'corrupt' ? 'corrupt-input' : 'unverified-object',
          detail: `association batch unavailable or invalid: ${detail}`,
        }
        const problem = {
          kind: 'association-batch',
          path: batchPath,
          classification,
          limitation,
        } as const
        inputProblems.push({ ...problem, problemId: reviewInputProblemId(problem) })
      }
    }
  }
  const snapshot = structuredClone({
    mode: request.mode,
    subject,
    candidates,
    reviews: history.reviews,
    coverageActions: history.coverageActions,
    associations,
    policies: request.policies,
    ...(request.sessionKey === undefined ? {} : { sessionKey: request.sessionKey }),
    ...(request.reviewLimits === undefined ? {} : { reviewLimits: request.reviewLimits }),
    historySources: history.sources.map(source => ({
      ...source,
      bytes: new Uint8Array(source.bytes),
    })),
    subjectLimitations,
    subjectObjectRefs,
    inputProblems,
  }) satisfies ReviewInputs
  const loaded = Object.freeze({}) as LoadedReviewInputs
  loadedReviewInputs.set(loaded, snapshot)
  return loaded
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
            [
              'eligible-included',
              'eligible-gap',
              'previously-analyzed-complete',
              'previously-analyzed-partial',
              'settled',
            ].includes(selection.coverageEffect),
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
                [
                  'eligible-included',
                  'eligible-gap',
                  'previously-analyzed-complete',
                  'previously-analyzed-partial',
                  'settled',
                ].includes(selection.coverageEffect),
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
  acceptedProblemIds: readonly string[],
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
      ...review.inputProblems
        .filter(problem => acceptedProblemIds.includes(problem.problemId))
        .map(problem => problem.limitation.code),
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
  const acceptedProblems = new Set<string>()
  const priorSelections = new Map<RecordId, ReviewEvidenceSelection>()
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
          (review.subjectAttempt.effect === 'current-included' &&
            review.subjectAttempt.limitations.length === 0)
            ? 'settled'
            : review.subjectAttempt.effect,
      }
      for (const selection of review.selections) {
        if (
          selection.selectedForReview &&
          ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect)
        ) {
          priorSelections.set(selection.triggerId, selection)
        }
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
                ['previously-analyzed-complete', 'settled'].includes(item.coverageEffect) &&
                (item.evidenceWatermark <= (settled[sessionKey] ?? 0) ||
                  priorReviewed.has(item.evidenceWatermark))
              ),
          )
        ) {
          throw new TypeError('complete review contains an unsettled evidence selection')
        }
        settled[sessionKey] = Math.max(settled[sessionKey] ?? 0, watermark)
        for (const selection of selections) {
          if (selection.coverageEffect === 'eligible-included') {
            acceptedOpaque.add(selection.triggerId)
          }
        }
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
            [
              'eligible-included',
              'eligible-gap',
              'previously-analyzed-complete',
              'settled',
            ].includes(selection.coverageEffect),
        )
      ) {
        throw new TypeError('coverage action watermark must name an exact eligible boundary')
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
    const acceptedProblemIds = [...new Set(action.acceptedProblemIds)].sort()
    if (
      acceptedProblemIds.some(id => !review.inputProblems.some(problem => problem.problemId === id))
    )
      throw new TypeError('coverage action names an unknown input problem')
    const expectedCodes = exactBlockingCodes(
      review,
      action.settledWatermarks,
      acceptedIds,
      acceptedProblemIds,
    )
    const actualCodes = [...new Set(action.acceptedLimitations)].sort()
    if (canonicalJson(expectedCodes) !== canonicalJson(actualCodes)) {
      throw new TypeError('coverage action must accept the exact blocking limitations')
    }
    for (const [sessionKey, watermark] of Object.entries(action.settledWatermarks)) {
      settled[sessionKey] = Math.max(settled[sessionKey] ?? 0, watermark)
    }
    acceptedIds.forEach(id => acceptedOpaque.add(id))
    acceptedProblemIds.forEach(id => acceptedProblems.add(id))
    for (const selection of review.selections) {
      if (
        selection.kind === 'range' &&
        selection.coverageEffect === 'eligible-gap' &&
        selection.evidenceWatermark <= (action.settledWatermarks[selection.sessionKey] ?? -1)
      ) {
        acceptedOpaque.add(selection.triggerId)
      }
    }
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
    acceptedTriggerIds: [...acceptedOpaque].sort(),
    acceptedProblemIds: [...acceptedProblems].sort(),
    priorSelections: Object.fromEntries(
      [...priorSelections].sort(([left], [right]) => left.localeCompare(right)),
    ),
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
function planVerifiedReview(input: ReviewInputs): ReviewPlan {
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
        candidate.repositoryObservation.startState === candidate.repositoryObservation.endState &&
        !candidate.repositoryObservation.limitations.some(
          limitation => limitation.code === 'repository-race',
        ) &&
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
  const subjectLimitations = [
    ...(input.subjectLimitations ?? input.subject.observation.limitations),
  ]
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
    const candidateLimitations = [
      ...('trigger' in candidate ? candidate.trigger.limitations : []),
      ...('trigger' in candidate ? candidate.turn.limitations : []),
      ...(candidate.limitations ?? []),
    ]
      .filter(
        (item, index, all) =>
          all.findIndex(other => canonicalJson(other) === canonicalJson(item)) === index,
      )
      .sort(
        (left, right) =>
          left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail),
      )
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
      (coverage.acceptedTriggerIds.includes(identity.triggerId) ||
        (identity.kind === 'range' &&
          identity.evidenceWatermark <= (coverage.settledWatermarks[identity.sessionKey] ?? -1)))
    ) {
      classification = 'excluded'
      reason = 'settled-trigger'
    } else if (
      !replayCoveredEvidence &&
      coverage.priorSelections[identity.triggerId] !== undefined &&
      coverage.priorSelections[identity.triggerId]!.classification === classification &&
      canonicalJson(coverage.priorSelections[identity.triggerId]!.limitations) ===
        canonicalJson(candidateLimitations)
    ) {
      classification = 'excluded'
      reason =
        coverage.priorSelections[identity.triggerId]!.coverageEffect === 'eligible-included'
          ? 'previously-analyzed-complete'
          : 'previously-analyzed-partial'
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
        : reason === 'previously-analyzed-complete'
          ? 'previously-analyzed-complete'
          : reason === 'previously-analyzed-partial'
            ? 'previously-analyzed-partial'
            : reason === 'settled-trigger'
              ? 'settled'
              : reason === 'session-limit' ||
                  candidate.limitations?.some(item => item.code === 'excluded-by-limit')
                ? 'deferred-by-limit'
                : scope === 'weak' || classification === 'weak-context'
                  ? 'context-only'
                  : classification === 'included'
                    ? 'eligible-included'
                    : 'eligible-gap'
    if (scope === 'weak' && classification !== 'excluded') {
      classification = 'weak-context'
      reason = 'same-non-detached-branch-without-exact-anchor'
    }
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
        ...candidateLimitations,
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
                proofs: provenance
                  .map(item => ({
                    batchId: item.batchId,
                    evidenceId: item.evidenceId,
                    authority: item.kind,
                  }))
                  .sort(compareCanonical),
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
      [
        'eligible-included',
        'eligible-gap',
        'previously-analyzed-complete',
        'previously-analyzed-partial',
        'settled',
      ].includes(selection.coverageEffect),
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
  if (input.subjectObjectRefs === undefined) collectObjectRefs(input.subject, refs)
  else input.subjectObjectRefs.forEach(reference => refs.set(canonicalJson(reference), reference))
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
  const activeInputProblems = (input.inputProblems ?? []).filter(
    problem => replayCoveredEvidence || !coverage.acceptedProblemIds.includes(problem.problemId),
  )
  const status = foundationalUnavailable
    ? 'unavailable'
    : !hasReviewableEvidence &&
        selections.some(selection => selection.coverageEffect === 'deferred-by-limit')
      ? 'pending-limit'
      : !hasReviewableEvidence &&
          selections.some(selection => selection.coverageEffect === 'eligible-gap')
        ? 'pending-partial'
        : !hasReviewableEvidence &&
            selections.some(selection => selection.coverageEffect === 'previously-analyzed-partial')
          ? 'pending-partial'
          : !hasReviewableEvidence && activeInputProblems.length > 0
            ? 'pending-partial'
            : !hasReviewableEvidence && subjectAttempt.effect === 'previously-analyzed-unsettled'
              ? 'pending-partial'
              : !hasReviewableEvidence &&
                  prior?.subjectFingerprint === fingerprint &&
                  !policyChanged
                ? 'already-reviewed'
                : 'ready'
  const limitations = [
    ...(subjectAttempt.effect === 'reviewed-partial' ||
    subjectAttempt.effect === 'previously-analyzed-unsettled'
      ? subjectLimitations
      : []),
    ...selections
      .filter(selection =>
        ['eligible-gap', 'previously-analyzed-partial'].includes(selection.coverageEffect),
      )
      .flatMap(selection => selection.limitations),
    ...activeInputProblems.map(problem => problem.limitation),
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
    historySources: [...(input.historySources ?? [])],
    inputProblems: [...activeInputProblems].sort(compareCanonical),
  }
}

/** Public planning entry: every nested input comes from the immutable repository loader. */
export function planReview(input: LoadedReviewInputs): ReviewPlan {
  const snapshot = loadedReviewInputs.get(input)
  if (snapshot === undefined)
    throw new TypeError('review inputs were not produced by loadReviewInputs')
  return planVerifiedReview(structuredClone(snapshot))
}

/** Test-only pure fold seam. Production package exports do not expose it. */
export function planReviewForTesting(input: ReviewInputs): ReviewPlan {
  return planVerifiedReview(input)
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

function validateReviewBundleManifest(value: unknown): asserts value is ReviewBundleManifest {
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new TypeError('bundle manifest must be an object')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    canonicalJson(keys) !== canonicalJson(['files', 'format', 'inventory', 'plan', 'schemaVersion'])
  )
    throw new TypeError('bundle manifest has unknown or missing fields')
  if (record.schemaVersion !== 1 || record.format !== 'factory-review-bundle')
    throw new TypeError('bundle manifest discriminator is invalid')
  if (!Array.isArray(record.files) || !Array.isArray(record.inventory))
    throw new TypeError('bundle manifest inventories must be arrays')
  for (const entry of record.files) {
    if (entry === null || Array.isArray(entry) || typeof entry !== 'object')
      throw new TypeError('bundle file entry must be an object')
    const file = entry as Record<string, unknown>
    if (
      canonicalJson(Object.keys(file).sort()) !==
        canonicalJson(['bytes', 'kind', 'path', 'sha256']) ||
      !['record', 'object'].includes(file.kind as string) ||
      typeof file.path !== 'string' ||
      file.path.startsWith('/') ||
      file.path.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0
    ) {
      throw new TypeError('bundle file entry is invalid')
    }
    if (file.kind === 'record' && !(file.path as string).startsWith('.factory/'))
      throw new TypeError('bundle record path is outside mirrored .factory')
    if (
      file.kind === 'object' &&
      file.path !== `.factory/${objectOwnedPath(file.sha256 as string)}`
    ) {
      throw new TypeError('bundle object path is not its exact CAS path')
    }
  }
  validateReviewPlanRecord(record.plan as ReviewPlanRecord)
  ;(record.inventory as unknown[]).forEach(item => validateObjectRef(item as ObjectRef))
}

export type ReviewPlanRecord = Omit<
  ReviewPlan,
  'subject' | 'evidence' | 'associations' | 'priorLedger' | 'objectInventory' | 'historySources'
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
  historySources: readonly {
    path: OwnedPath
    sha256: string
    bytes: number
    kind: LoadedHistorySource['kind']
  }[]
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
    'historySources',
    'inputProblems',
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
  const fullReviewReasons = [
    'initial-review',
    'explicit-full',
    'explicit-force',
    'subject-changed',
    'limitations-changed',
    'policy-changed',
  ]
  if (
    (plan.fullReviewReason !== undefined && !fullReviewReasons.includes(plan.fullReviewReason)) ||
    (plan.fullReviewReason !== undefined && plan.subjectReview === 'none') ||
    (plan.subject.kind === 'workspace' && plan.subjectReview === 'full-current-pr-diff') ||
    (plan.subject.kind === 'pull-request' && plan.subjectReview === 'full-current-code') ||
    (plan.replayCoveredEvidence &&
      !['explicit-full', 'explicit-force'].includes(plan.fullReviewReason ?? '')) ||
    (!plan.replayCoveredEvidence &&
      ['explicit-full', 'explicit-force'].includes(plan.fullReviewReason ?? ''))
  ) {
    throw new TypeError('review plan full-review state is contradictory')
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
    inputProblems: plan.inputProblems,
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
  const selectedRanges = plan.selections.filter(
    (selection): selection is ReviewEvidenceSelection & { kind: 'range' } =>
      selection.kind === 'range' &&
      selection.selectedForReview &&
      ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect),
  )
  const expectedSessions = [...new Set(selectedRanges.map(selection => selection.sessionKey))]
    .sort()
    .map(sessionKey => {
      const values = selectedRanges.filter(selection => selection.sessionKey === sessionKey)
      return {
        sessionKey,
        toInclusive: Math.max(...values.map(selection => selection.evidenceWatermark)),
        triggerIds: values.map(selection => selection.triggerId).sort(),
      }
    })
  const actualSessions = plan.sessions.map(session => ({
    sessionKey: session.sessionKey,
    toInclusive: session.toInclusive,
    triggerIds: session.triggerIds,
  }))
  if (
    plan.sessions.some(
      session =>
        Object.keys(session).sort().join(',') !==
          'fromExclusive,sessionKey,toInclusive,triggerIds' ||
        typeof session.sessionKey !== 'string' ||
        session.sessionKey.length === 0 ||
        !Number.isSafeInteger(session.fromExclusive) ||
        session.fromExclusive < 0 ||
        !Number.isSafeInteger(session.toInclusive) ||
        session.toInclusive <= session.fromExclusive,
    ) ||
    canonicalJson(actualSessions) !== canonicalJson(expectedSessions)
  ) {
    throw new TypeError('review plan Session ranges differ from selected evidence')
  }
  const hasSelected = plan.selections.some(selection => selection.selectedForReview)
  const hasGap = plan.selections.some(selection => selection.coverageEffect === 'eligible-gap')
  const hasDeferred = plan.selections.some(
    selection => selection.coverageEffect === 'deferred-by-limit',
  )
  if (plan.status === 'ready' && plan.subjectReview === 'none' && !hasSelected)
    throw new TypeError('ready review plan has no reviewable input')
  if (
    plan.status === 'already-reviewed' &&
    (plan.subjectAttempt.effect !== 'settled' ||
      plan.subjectReview !== 'none' ||
      hasSelected ||
      hasGap ||
      hasDeferred ||
      plan.limitations.length > 0)
  ) {
    throw new TypeError('already-reviewed plan has unresolved or selected work')
  }
  if (
    plan.status === 'pending-partial' &&
    (plan.subjectReview !== 'none' || hasSelected || (!hasGap && plan.limitations.length === 0))
  ) {
    throw new TypeError('pending-partial plan has reviewable input or no blocker')
  }
  if (
    plan.status === 'pending-limit' &&
    (!hasDeferred || plan.subjectReview !== 'none' || hasSelected)
  )
    throw new TypeError('pending-limit plan does not represent deferred work only')
  const canonicalHistory = [...plan.historySources].sort((left, right) =>
    left.path.localeCompare(right.path),
  )
  if (
    canonicalJson(canonicalHistory) !== canonicalJson(plan.historySources) ||
    new Set(plan.historySources.map(source => source.path)).size !== plan.historySources.length ||
    plan.historySources.some(
      source =>
        !Number.isSafeInteger(source.bytes) ||
        source.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(source.sha256) ||
        historySourceKind(source.path) !== source.kind,
    )
  ) {
    throw new TypeError('review plan history sources are invalid or noncanonical')
  }
  const canonicalProblems = [...plan.inputProblems].sort(compareCanonical)
  for (const problem of plan.inputProblems) {
    const keys = Object.keys(problem).sort()
    const expectedKeys =
      problem.kind === 'association-batch'
        ? ['classification', 'kind', 'limitation', 'path', 'problemId']
        : ['classification', 'field', 'kind', 'limitation', 'object', 'problemId']
    if (canonicalJson(keys) !== canonicalJson(expectedKeys))
      throw new TypeError('review plan input problem has unknown or missing fields')
    if (problem.kind === 'association-batch') {
      assertOwnedRecordPath(problem.path)
      if (!['unavailable', 'unsafe', 'corrupt'].includes(problem.classification))
        throw new TypeError('association problem classification is invalid')
    } else {
      validateObjectRef(problem.object)
      if (
        !['codeManifest', 'stagedPatch', 'unstagedPatch', 'raw', 'limitation'].includes(
          problem.field,
        ) ||
        !['unavailable', 'unsafe', 'corrupt', 'excluded'].includes(problem.classification)
      )
        throw new TypeError('subject object problem is invalid')
    }
    const { problemId: _problemId, ...payload } = problem
    if (problem.problemId !== reviewInputProblemId(payload))
      throw new TypeError('review plan input problem ID differs from its payload')
    if (!plan.limitations.some(item => canonicalJson(item) === canonicalJson(problem.limitation)))
      throw new TypeError('review plan input problem limitation is not active')
    if (
      problem.kind === 'subject-object' &&
      !plan.subjectAttempt.limitations.some(
        item => canonicalJson(item) === canonicalJson(problem.limitation),
      )
    )
      throw new TypeError('subject object problem is absent from subject coverage')
  }
  if (
    canonicalJson(canonicalProblems) !== canonicalJson(plan.inputProblems) ||
    new Set(plan.inputProblems.map(problem => problem.problemId)).size !==
      plan.inputProblems.length ||
    plan.inputProblems.some(problem => !/^[a-f0-9]{64}$/.test(problem.problemId))
  )
    throw new TypeError('review plan input problems are invalid or noncanonical')
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
    historySources: plan.historySources.map(source => ({
      path: source.path,
      sha256: source.sha256,
      bytes: source.bytes.byteLength,
      kind: source.kind,
    })),
    inputProblems: plan.inputProblems,
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
  for (const source of plan.historySources) {
    assertOwnedRecordPath(source.path)
    if (sha256(source.bytes) !== source.sha256) {
      throw new TypeError(`history source bytes changed after loading: ${source.path}`)
    }
    const prior = records.get(source.path)
    if (prior !== undefined && sha256(prior) !== source.sha256) {
      throw new TypeError(`history source conflicts with current bundle record: ${source.path}`)
    }
    records.set(source.path, new Uint8Array(source.bytes))
  }
  return new Map([...records].sort(([left], [right]) => left.localeCompare(right)))
}

async function expandInventory(
  plan: ReviewPlan,
  source: ReviewObjectSource,
): Promise<{ bytes: Map<string, Uint8Array>; refs: ObjectRef[] }> {
  const pending = [...plan.objectInventory]
  const omitted = new Set(
    plan.inputProblems
      .filter(
        (problem): problem is Extract<ReviewInputProblem, { kind: 'subject-object' }> =>
          problem.kind === 'subject-object',
      )
      .map(problem => canonicalJson(problem.object)),
  )
  const bytesByHash = new Map<string, Uint8Array>()
  const refs = new Map<string, ObjectRef>()
  let aggregateBytes = 0
  while (pending.length > 0) {
    const ref = pending.shift()!
    if (omitted.has(canonicalJson(ref))) continue
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
      pending.push(
        ...[...nested.values()].filter(reference => !omitted.has(canonicalJson(reference))),
      )
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
  const treeEntries = new Set<string>(['bundle.json'])
  for (const file of files) {
    treeEntries.add(file.path)
    const segments = file.path.split('/')
    for (let index = 1; index < segments.length; index += 1)
      treeEntries.add(segments.slice(0, index).join('/'))
  }
  if (treeEntries.size > plan.limits.maxTreeEntries)
    throw new Error('bundle exceeds total tree-entry bound')
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

/** Verify using only the bundle's mirrored `.factory`; no live checkout or Git metadata is read. */
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
    const decoded = JSON.parse(text) as unknown
    if (canonicalJson(decoded) !== text) {
      throw new Error('bundle manifest is invalid or noncanonical')
    }
    validateReviewBundleManifest(decoded)
    const manifest = decoded
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
      maximumEntries: manifest.plan.limits.maxTreeEntries,
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
      if (file.kind === 'record' && !file.path.startsWith('.factory/'))
        throw new Error('bundle record path is outside its mirrored .factory')
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
    const canonicalHistorySources = [...manifest.plan.historySources].sort((left, right) =>
      left.path.localeCompare(right.path),
    )
    if (
      canonicalJson(canonicalHistorySources) !== canonicalJson(manifest.plan.historySources) ||
      new Set(manifest.plan.historySources.map(source => source.path)).size !==
        manifest.plan.historySources.length
    ) {
      throw new Error('bundle history sources are not canonical and unique')
    }
    for (const source of manifest.plan.historySources) {
      const bytes = recordBytes.get(source.path)
      if (
        bytes === undefined ||
        bytes.byteLength !== source.bytes ||
        sha256(bytes) !== source.sha256
      ) {
        throw new Error('bundle omits or changes a pinned history source')
      }
    }
    if (manifest.plan.historySources.length > 0) {
      const rebuiltHistory = await loadReviewHistory(
        {
          read: async ownedPath => {
            const bytes = recordBytes.get(ownedPath)
            return bytes === undefined
              ? { kind: 'missing', detail: `bundle omits ${ownedPath}` }
              : { kind: 'readable', bytes }
          },
          getObject: async () => ({ kind: 'missing', detail: 'history does not load objects' }),
        },
        {
          reviews: manifest.plan.historySources
            .filter(source => source.kind === 'review-manifest')
            .map(source => ({ manifestPath: source.path })),
          coverageActionPaths: manifest.plan.historySources
            .filter(source => source.kind === 'coverage-action')
            .map(source => source.path),
        },
      )
      const rebuiltSources = loadedHistories.get(rebuiltHistory)?.sources
      if (
        rebuiltSources === undefined ||
        canonicalJson(
          rebuiltSources.map(source => ({
            path: source.path,
            sha256: source.sha256,
            bytes: source.bytes.byteLength,
            kind: source.kind,
          })),
        ) !== canonicalJson(manifest.plan.historySources)
      ) {
        throw new Error('bundle history sources differ from the validated history closure')
      }
    }
    const readBundleObject = async (ref: ObjectRef): Promise<Uint8Array> => {
      if (!manifest.inventory.some(item => canonicalJson(item) === canonicalJson(ref))) {
        throw new Error(`bundle inventory omits referenced object: ${ref.sha256}`)
      }
      const bytes = await readConfinedFile(
        path,
        splitPortablePath(`.factory/${objectOwnedPath(ref.sha256)}`),
        { maximumBytes: manifest.plan.limits.maxBundleBytes },
      )
      if (bytes.byteLength !== ref.bytes || sha256(bytes) !== ref.sha256)
        throw new Error(`bundle referenced object failed verification: ${ref.sha256}`)
      return bytes
    }
    const subjectPath =
      manifest.plan.subject.kind === 'workspace'
        ? `repository-observations/${manifest.plan.subject.observationId}.json`
        : `pull-requests/github/${manifest.plan.subject.repositoryKey}/${manifest.plan.subject.number}/observations/${manifest.plan.subject.observationId}.json`
    if (!recordValues.has(subjectPath)) throw new Error('bundle omits its subject observation')
    const expectedRecordPaths = new Set<string>([
      subjectPath,
      ...manifest.plan.historySources.map(source => source.path),
      ...(manifest.plan.priorLedger === undefined ? [] : [manifest.plan.priorLedger.path]),
    ])
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
    const bundledCodeManifest =
      bundledSubject.observation.codeManifest === undefined ||
      !manifest.inventory.some(
        item => canonicalJson(item) === canonicalJson(bundledSubject.observation.codeManifest),
      )
        ? undefined
        : parseCodeManifest(
            JSON.parse(
              new TextDecoder().decode(
                await readBundleObject(bundledSubject.observation.codeManifest),
              ),
            ),
          )
    if (subjectFingerprint(bundledSubject) !== manifest.plan.subjectFingerprint) {
      throw new Error('bundle subject fingerprint differs from its subject bytes')
    }
    const expectedObjectRefs = new Map<string, ObjectRef>()
    collectObjectRefs(bundledSubject, expectedObjectRefs)
    for (const problem of manifest.plan.inputProblems)
      if (problem.kind === 'subject-object')
        expectedObjectRefs.delete(canonicalJson(problem.object))
    for (const problem of manifest.plan.inputProblems) {
      if (
        !manifest.plan.limitations.some(
          item => canonicalJson(item) === canonicalJson(problem.limitation),
        )
      )
        throw new Error('bundle input problem limitation is not an active plan blocker')
      if (problem.kind === 'subject-object') {
        const reference = (() => {
          if (problem.field === 'codeManifest') return bundledSubject.observation.codeManifest
          if (bundledSubject.kind === 'workspace') {
            if (problem.field === 'stagedPatch') return bundledSubject.observation.stagedPatch
            if (problem.field === 'unstagedPatch') return bundledSubject.observation.unstagedPatch
          } else if (problem.field === 'raw') {
            return bundledSubject.observation.raw.find(
              item => canonicalJson(item) === canonicalJson(problem.object),
            )
          }
          if (problem.field === 'limitation')
            return [
              ...bundledSubject.observation.limitations,
              ...(bundledCodeManifest?.limitations ?? []),
            ]
              .map(limitation => limitation.object)
              .find(item => canonicalJson(item) === canonicalJson(problem.object))
          return undefined
        })()
        if (
          reference === undefined ||
          canonicalJson(reference) !== canonicalJson(problem.object) ||
          !manifest.plan.subjectAttempt.limitations.some(
            item => canonicalJson(item) === canonicalJson(problem.limitation),
          )
        )
          throw new Error('bundle subject object problem is forged or detached from coverage')
      }
    }
    if (bundledSubject.kind === 'workspace') {
      const observation = bundledSubject.observation
      if (observation.codeManifest === undefined)
        throw new Error('bundle workspace subject lacks foundational code manifest')
      if (bundledCodeManifest === undefined)
        throw new Error('bundle workspace subject omits its foundational code manifest')
      const codeManifest = bundledCodeManifest
      collectObjectRefs(codeManifest, expectedObjectRefs)
      const codeRefs = new Map<string, ObjectRef>()
      collectObjectRefs(codeManifest, codeRefs)
      for (const reference of codeRefs.values()) {
        const omitted = manifest.plan.inputProblems.some(
          problem =>
            problem.kind === 'subject-object' &&
            canonicalJson(problem.object) === canonicalJson(reference),
        )
        if (omitted) expectedObjectRefs.delete(canonicalJson(reference))
        else await readBundleObject(reference)
      }
      for (const reference of [observation.stagedPatch, observation.unstagedPatch]) {
        if (
          reference !== undefined &&
          manifest.inventory.some(item => canonicalJson(item) === canonicalJson(reference))
        )
          await readBundleObject(reference)
        else if (
          reference !== undefined &&
          !manifest.plan.inputProblems.some(
            problem =>
              problem.kind === 'subject-object' &&
              problem.field ===
                (reference === observation.stagedPatch ? 'stagedPatch' : 'unstagedPatch') &&
              canonicalJson(problem.object) === canonicalJson(reference),
          )
        )
          throw new Error('bundle omits workspace patch without an exact limitation')
      }
    } else {
      await readBundleObject(bundledSubject.observation.diff)
      if (
        bundledSubject.observation.codeManifest !== undefined &&
        manifest.inventory.some(
          item => canonicalJson(item) === canonicalJson(bundledSubject.observation.codeManifest),
        )
      ) {
        await verifyCodeManifestClosure(bundledSubject.observation.codeManifest, readBundleObject)
        const codeManifest = bundledCodeManifest
        if (codeManifest === undefined)
          throw new Error('bundle optional PR code manifest cannot be decoded')
        collectObjectRefs(codeManifest, expectedObjectRefs)
      } else if (
        bundledSubject.observation.codeManifest !== undefined &&
        !manifest.plan.inputProblems.some(
          problem =>
            problem.kind === 'subject-object' &&
            problem.field === 'codeManifest' &&
            canonicalJson(problem.object) ===
              canonicalJson(bundledSubject.observation.codeManifest),
        )
      ) {
        throw new Error('bundle omits optional PR code without an exact limitation')
      }
    }
    if (manifest.plan.priorLedger !== undefined) {
      await readBundleObject(manifest.plan.priorLedger.object)
      const ledger = recordValues.get(manifest.plan.priorLedger.path)?.[0]
      if (ledger === undefined) throw new Error('bundle omits chosen prior ledger record')
      const citations = new Map<string, ObjectRef>()
      collectObjectRefs(ledger, citations)
      expectedObjectRefs.set(
        canonicalJson(manifest.plan.priorLedger.object),
        manifest.plan.priorLedger.object,
      )
      citations.forEach((reference, key) => expectedObjectRefs.set(key, reference))
      for (const reference of citations.values()) await readBundleObject(reference)
    }
    const bundledAssociationProofs = new Map<
      string,
      { evidence: SessionPullRequestAssociation; batchId: RecordId }
    >()
    if (manifest.plan.subject.kind === 'pull-request') {
      const observation = recordValues.get(subjectPath)?.[0] as AvailablePullRequestObservation
      const associationRoot = `pull-requests/github/${manifest.plan.subject.repositoryKey}/${manifest.plan.subject.number}/associations/${manifest.plan.subject.observationId}`
      const namedEvidence = new Set<string>()
      for (const batchId of manifest.plan.associationBatchIds) {
        const batchPath = `${associationRoot}/batches/${batchId}.json`
        expectedRecordPaths.add(batchPath)
        const batch = recordValues.get(batchPath)?.[0] as AssociationBatch | undefined
        if (batch === undefined) throw new Error('bundle omits a completed association batch')
        collectObjectRefs(batch, expectedObjectRefs)
        const evidence = batch.evidence.map(reference => {
          namedEvidence.add(reference.evidenceId)
          const value = recordValues.get(`${associationRoot}/${reference.evidenceId}.json`)?.[0]
          expectedRecordPaths.add(`${associationRoot}/${reference.evidenceId}.json`)
          if (value === undefined) throw new Error('bundle omits batch-named association evidence')
          bundledAssociationProofs.set(`${batchId}\0${reference.evidenceId}`, {
            evidence: value as SessionPullRequestAssociation,
            batchId,
          })
          collectObjectRefs(value, expectedObjectRefs)
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
      if (manifest.plan.subject.kind === 'pull-request' && selection.kind === 'range') {
        const expectedProofs = [...bundledAssociationProofs.entries()]
          .filter(([, bundled]) =>
            bundled.evidence.kind === 'invalidation'
              ? false
              : bundled.evidence.sessionKey === selection.sessionKey,
          )
          .map(([key, bundled]) => ({
            batchId: key.split('\0')[0] as RecordId,
            evidenceId: bundled.evidence.evidenceId,
            authority:
              bundled.evidence.kind === 'manual'
                ? ('manual-asserted' as const)
                : ('verified-exact' as const),
          }))
          .sort(compareCanonical)
        if (canonicalJson(expectedProofs) !== canonicalJson(selection.association?.proofs ?? [])) {
          throw new Error('bundle selection omits or adds association proof authority')
        }
      }
      for (const proof of selection.association?.proofs ?? []) {
        const bundled = bundledAssociationProofs.get(`${proof.batchId}\0${proof.evidenceId}`)
        if (
          bundled === undefined ||
          bundled.evidence.kind === 'invalidation' ||
          selection.kind !== 'range' ||
          bundled.evidence.sessionKey !== selection.sessionKey ||
          proof.authority !==
            (bundled.evidence.kind === 'manual' ? 'manual-asserted' : 'verified-exact')
        ) {
          throw new Error('bundle selection association proof is forged or cross-wired')
        }
      }
      if (!selection.selectedForReview) continue
      if (selection.kind !== 'range')
        throw new Error('bundle cannot include an opaque problem as readable evidence')
      const triggerPath = `review-triggers/${selection.triggerId}.json`
      expectedRecordPaths.add(triggerPath)
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
      collectObjectRefs(loaded, expectedObjectRefs)
      const turnRoot = `sessions/${loaded.trigger.provider}/${loaded.trigger.sessionKey}/turns/${loaded.turn.turnId}`
      expectedRecordPaths.add(
        `sessions/${loaded.trigger.provider}/${loaded.trigger.sessionKey}/identity.json`,
      )
      expectedRecordPaths.add(`${turnRoot}/manifest.json`)
      expectedRecordPaths.add(`${turnRoot}/events.jsonl`)
      expectedRecordPaths.add(`${turnRoot}/transcript.jsonl`)
      if (loaded.repositoryObservation !== undefined)
        expectedRecordPaths.add(
          `repository-observations/${loaded.repositoryObservation.observationId}.json`,
        )
    }
    if (
      canonicalJson([...expectedRecordPaths].sort()) !==
      canonicalJson([...recordBytes.keys()].sort())
    )
      throw new Error('bundle record files differ from the exact compact-plan closure')
    if (
      canonicalJson([...expectedObjectRefs.values()].sort(compareCanonical)) !==
      canonicalJson(manifest.inventory)
    )
      throw new Error('bundle object inventory differs from the exact semantic closure')
    return { valid: true, sha256: digest, manifest }
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
