import { createHash } from 'node:crypto'

import {
  assertOwnedRecordPath,
  canonicalJson,
  makeOwnedPath,
  reviewSubjectCoverageId,
  reviewInputProblemId,
  validateObjectRef,
  validatePublicRecord,
  type AssociationBatch,
  type AvailablePullRequestObservation,
  type CoverageAction,
  type Limitation,
  type ObjectRef,
  type OwnedPath,
  type RecordId,
  type RepositoryObservation,
  type ReviewLedger,
  type ReviewInputProblem,
  type ReviewEvidenceSelection as ContractReviewEvidenceSelection,
  type ResolvedReviewerSettings,
  type ReviewTrigger,
  type SessionPullRequestAssociation,
} from '@factory/contract'
import { verifyAssociationBatch } from '@factory/github'
import { loadCodeManifestObject } from '@factory/repository'

import {
  loadCandidateEvidence,
  type CandidateEvidence,
  type CandidateProblem,
  type CandidateScopeProof,
  type EvidenceClassification,
  type ReviewCandidate,
} from './candidate-loader'
import { foldCoverage } from './coverage'
import { getLoadedReviewHistoryState, selectReviewHistory } from './history-loader'
import {
  isTrustedReviewRepositoryReader,
  type PortableRecordReader,
  type ReviewRepositoryReader,
} from './repository-reader'
import { effectiveLimits, subjectFingerprint } from './semantics'

export {
  openReviewRepositoryReader,
  type PortableRecordReader,
  type ReviewRepositoryReader,
} from './repository-reader'
export {
  loadCandidateEvidence,
  type CandidateRecordDescriptor,
  type ReviewCandidate,
} from './candidate-loader'
export { loadReviewHistory, loadReviewHistoryForTesting } from './history-loader'
export { foldCoverage } from './coverage'
export {
  buildBundle,
  validateReviewPlanRecord,
  verifyBundle,
  type BundleVerification,
  type ReviewAcceptanceAuthority,
  type ReviewAcceptanceProjection,
  type ReviewBundleManifest,
  type ReviewPlanRecord,
} from './bundle'

export type ReviewSubject =
  | { kind: 'workspace'; observation: RepositoryObservation }
  | { kind: 'pull-request'; observation: AvailablePullRequestObservation }

function decodeCanonicalRecord(path: string, bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value = JSON.parse(text) as unknown
  if (canonicalJson(value) !== text) throw new TypeError('record is not canonical JSON')
  assertOwnedRecordPath(path)
  validatePublicRecord(path, value)
  return value
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
  limitations?: readonly Limitation[]
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

declare const loadedReviewHistoryBrand: unique symbol
export type LoadedReviewHistory = { readonly [loadedReviewHistoryBrand]: true }

export type ReviewHistoryLoadRequest = {
  reviews: readonly ReviewHistoryDescriptor[]
  coverageActionPaths: readonly OwnedPath[]
}

export type ReviewPolicies = {
  reviewer: ResolvedReviewerSettings
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
  historyValidationObjects?: readonly ObjectRef[]
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

/** Load and defensively freeze every repository-owned input before planning. */
async function loadReviewInputsFromReader(
  reader: ReviewRepositoryReader,
  request: ReviewInputLoadRequest,
): Promise<LoadedReviewInputs> {
  const loadedHistory = getLoadedReviewHistoryState(request.history)
  if (loadedHistory === undefined)
    throw new TypeError('review history was not produced by loadReviewHistory')
  if (loadedHistory.reader !== reader)
    throw new TypeError('review history and current inputs must share one confined snapshot')
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
  const history = selectReviewHistory(loadedHistory, subject)
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
      object,
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
  // PR visibility is established before candidate admission so unrelated repository
  // Sessions cannot consume the bounded acquisition budget ahead of exact/manual evidence.
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
  const associatedSessionKeys = new Set(
    associations.flatMap(group =>
      group.evidence.flatMap(evidence =>
        evidence.kind === 'invalidation' ? [] : [evidence.sessionKey],
      ),
    ),
  )
  const discoveredTriggers = await Promise.all(
    candidateTriggerIds.map(async triggerId => {
      try {
        return {
          triggerId,
          trigger: (
            await readRequiredRecord(
              reader,
              makeOwnedPath('review-triggers', [`${triggerId}.json`]),
            )
          ).value as ReviewTrigger,
        }
      } catch {
        return { triggerId }
      }
    }),
  )
  const requestedTriggers = discoveredTriggers.filter(
    item =>
      item.trigger === undefined ||
      ((request.sessionKey === undefined || item.trigger.sessionKey === request.sessionKey) &&
        (subject.kind === 'workspace' || associatedSessionKeys.has(item.trigger.sessionKey))),
  )
  const sessionLimit = effectiveLimits(request.reviewLimits).maxSessions
  const acquisitionRanks = new Map<string, number>()
  if (subject.kind === 'workspace') {
    await Promise.all(
      requestedTriggers.map(async item => {
        if (item.trigger === undefined) return
        let rank = 1
        try {
          const turnPath = makeOwnedPath('sessions', [
            item.trigger.provider,
            item.trigger.sessionKey,
            'turns',
            item.trigger.turnId,
            'manifest.json',
          ])
          const turn = (await readRequiredRecord(reader, turnPath)).value as {
            repositoryObservationId?: RecordId
          }
          if (turn.repositoryObservationId !== undefined) {
            const observation = (
              await readRequiredRecord(
                reader,
                makeOwnedPath('repository-observations', [`${turn.repositoryObservationId}.json`]),
              )
            ).value as RepositoryObservation
            if (
              observation.startState === observation.endState &&
              !observation.limitations.some(item => item.code === 'repository-race') &&
              subjectFingerprint({ kind: 'workspace', observation }) === subjectFingerprint(subject)
            )
              rank = 0
          }
        } catch {
          rank = 0 // Acquisition gaps are in-scope attempts and outrank optional weak context.
        }
        acquisitionRanks.set(
          item.trigger.sessionKey,
          Math.min(acquisitionRanks.get(item.trigger.sessionKey) ?? rank, rank),
        )
      }),
    )
  }
  const admittedSessionKeys = new Set(
    [...new Set(requestedTriggers.flatMap(item => item.trigger?.sessionKey ?? []))]
      .sort(
        (left, right) =>
          (acquisitionRanks.get(left) ?? 0) - (acquisitionRanks.get(right) ?? 0) ||
          left.localeCompare(right),
      )
      .slice(0, sessionLimit),
  )
  const candidateScope = (triggerId: RecordId): CandidateScopeProof =>
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
        : { kind: 'diagnostic-only' }
  const candidates: ReviewCandidate[] = await Promise.all(
    requestedTriggers.map(async item => {
      if (item.trigger !== undefined && !admittedSessionKeys.has(item.trigger.sessionKey)) {
        return {
          kind: 'range',
          triggerId: item.trigger.triggerId,
          sessionKey: item.trigger.sessionKey,
          turnId: item.trigger.turnId,
          evidenceWatermark: item.trigger.evidenceWatermark,
          scopeProof: candidateScope(item.triggerId),
          availability: 'excluded',
          limitations: [
            {
              code: 'excluded-by-limit',
              detail: 'Session evidence deferred by the configured review acquisition limit',
            },
          ],
        } satisfies CandidateProblem
      }
      return await loadCandidateEvidence(reader, {
        triggerId: item.triggerId,
        scopeProof:
          item.trigger === undefined && request.sessionKey !== undefined
            ? { kind: 'diagnostic-only' }
            : candidateScope(item.triggerId),
      })
    }),
  )
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
    historyValidationObjects: history.validationObjects.map(reference =>
      structuredClone(reference),
    ),
    subjectLimitations,
    subjectObjectRefs,
    inputProblems,
  }) satisfies ReviewInputs
  const loaded = Object.freeze({}) as LoadedReviewInputs
  loadedReviewInputs.set(loaded, snapshot)
  return loaded
}

export async function loadReviewInputs(
  reader: ReviewRepositoryReader,
  request: ReviewInputLoadRequest,
): Promise<LoadedReviewInputs> {
  if (!isTrustedReviewRepositoryReader(reader))
    throw new TypeError('review repository reader was not opened from a confined tree snapshot')
  return await loadReviewInputsFromReader(reader, request)
}

/** Test-only raw reader seam; it cannot mint the production repository-reader brand. */
export async function loadReviewInputsForTesting(
  reader: ReviewRepositoryReader,
  request: ReviewInputLoadRequest,
): Promise<LoadedReviewInputs> {
  return await loadReviewInputsFromReader(reader, request)
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
  input.historyValidationObjects?.forEach(reference =>
    refs.set(canonicalJson(reference), reference),
  )
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

/** Derive authoring context from exact attempted ranges in loader-owned evidence. */
export function reviewAuthoringProvider(input: LoadedReviewInputs): 'codex' | 'claude' | undefined {
  const snapshot = loadedReviewInputs.get(input)
  if (snapshot === undefined)
    throw new TypeError('review inputs were not produced by loadReviewInputs')
  const plan = planVerifiedReview(structuredClone(snapshot))
  const attempted = new Set(
    plan.selections
      .filter(
        selection =>
          selection.kind === 'range' &&
          ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect),
      )
      .map(selection => selection.triggerId),
  )
  return snapshot.candidates
    .filter((candidate): candidate is CandidateEvidence => 'trigger' in candidate)
    .filter(candidate => attempted.has(candidate.trigger.triggerId))
    .sort(
      (left, right) =>
        right.trigger.createdAt.localeCompare(left.trigger.createdAt) ||
        right.trigger.triggerId.localeCompare(left.trigger.triggerId),
    )[0]?.trigger.provider
}

/** Test-only pure fold seam. Production package exports do not expose it. */
export function planReviewForTesting(input: ReviewInputs): ReviewPlan {
  return planVerifiedReview(input)
}
