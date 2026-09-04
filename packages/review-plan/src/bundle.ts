import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  assertOwnedRecordPath,
  canonicalJson,
  makeOwnedPath,
  objectOwnedPath,
  parseCodeManifest,
  reviewInputProblemId,
  validateObjectRef,
  validatePublicRecord,
  type AssociationBatch,
  type AvailablePullRequestObservation,
  type EvidenceEnvelope,
  type Limitation,
  type ObjectRef,
  type OwnedPath,
  type RepositoryObservation,
  type RecordId,
  type ReviewManifest,
  type ReviewTrigger,
  type ReviewInputProblem,
  type SessionPullRequestAssociation,
} from '@factory/contract'
import { verifyAssociationBatch } from '@factory/github'
import {
  inventoryConfinedTree,
  loadCodeManifestObject,
  readConfinedFile,
} from '@factory/repository'

import { loadCandidateEvidence } from './candidate-loader'
import { getLoadedReviewHistoryState, loadReviewHistoryFromRequest } from './history-loader'
import type {
  EffectiveReviewLimits,
  LoadedHistorySource,
  ReviewEvidenceSelection,
  ReviewPlan,
  ReviewSubject,
} from './index'

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

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const compareCanonical = (left: unknown, right: unknown) =>
  canonicalJson(left).localeCompare(canonicalJson(right))
function effectiveLimits(
  configured: { maxBundleBytes?: number; maxSessions?: number } | undefined,
): EffectiveReviewLimits {
  const clamp = (value: number | undefined, fallback: number, ceiling: number) =>
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
      if (
        !['unavailable', 'unsafe', 'corrupt'].includes(problem.classification) ||
        plan.subject.kind !== 'pull-request' ||
        !problem.path.startsWith(
          `pull-requests/github/${plan.subject.repositoryKey}/${plan.subject.number}/associations/${plan.subject.observationId}/batches/`,
        )
      )
        throw new TypeError('association problem classification is invalid')
    } else {
      validateObjectRef(problem.object)
      if (
        !['codeManifest', 'stagedPatch', 'unstagedPatch', 'raw', 'limitation'].includes(
          problem.field,
        ) ||
        !['unavailable', 'unsafe', 'corrupt', 'excluded'].includes(problem.classification) ||
        canonicalJson(problem.limitation.object) !== canonicalJson(problem.object)
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
  const historyValidationRoots = new Set(
    plan.historySources
      .filter(source => source.kind === 'review-manifest')
      .flatMap(source => {
        const value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(source.bytes),
        ) as ReviewManifest
        return value.codeManifest !== undefined &&
          value.inputProblems.some(
            problem => problem.kind === 'subject-object' && problem.field === 'limitation',
          )
          ? [canonicalJson(value.codeManifest)]
          : []
      }),
  )
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
      ref.role === 'workspace-code-manifest' &&
      !historyValidationRoots.has(canonicalJson(ref))
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
      const rebuiltHistory = await loadReviewHistoryFromRequest(
        {
          read: async ownedPath => {
            const bytes = recordBytes.get(ownedPath)
            return bytes === undefined
              ? { kind: 'missing', detail: `bundle omits ${ownedPath}` }
              : { kind: 'readable', bytes }
          },
          getObject: async reference => {
            if (!manifest.inventory.some(item => canonicalJson(item) === canonicalJson(reference)))
              return { kind: 'missing', detail: `bundle omits history object ${reference.sha256}` }
            try {
              const bytes = await readConfinedFile(
                path,
                splitPortablePath(`.factory/${objectOwnedPath(reference.sha256)}`),
                { maximumBytes: manifest.plan.limits.maxBundleBytes },
              )
              return { kind: 'readable', bytes }
            } catch (error) {
              return {
                kind: 'unsafe',
                detail: error instanceof Error ? error.message : String(error),
              }
            }
          },
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
      const rebuiltSources = getLoadedReviewHistoryState(rebuiltHistory)?.sources
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
    for (const source of manifest.plan.historySources) {
      if (source.kind !== 'review-manifest') continue
      const historicalManifest = recordValues.get(source.path)?.[0] as ReviewManifest | undefined
      if (historicalManifest?.codeManifest === undefined) continue
      const historicalSubjectPath =
        historicalManifest.subject.kind === 'workspace'
          ? `repository-observations/${historicalManifest.subject.repositoryObservationId}.json`
          : `pull-requests/${historicalManifest.subject.provider}/${historicalManifest.subject.repositoryKey}/${historicalManifest.subject.number}/observations/${historicalManifest.subject.observationId}.json`
      const historicalSubject = recordValues.get(historicalSubjectPath)?.[0] as
        | RepositoryObservation
        | AvailablePullRequestObservation
        | undefined
      if (historicalSubject === undefined) continue
      const directLimitationRefs = new Set(
        historicalSubject.limitations.map(limitation => canonicalJson(limitation.object)),
      )
      if (
        historicalManifest.inputProblems.some(
          problem =>
            problem.kind === 'subject-object' &&
            problem.field === 'limitation' &&
            !directLimitationRefs.has(canonicalJson(problem.object)),
        )
      )
        expectedObjectRefs.set(
          canonicalJson(historicalManifest.codeManifest),
          historicalManifest.codeManifest,
        )
    }
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
