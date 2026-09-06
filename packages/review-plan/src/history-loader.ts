import { createHash } from 'node:crypto'

import {
  assertOwnedRecordPath,
  canonicalJson,
  makeOwnedPath,
  validatePublicRecord,
  type AvailablePullRequestObservation,
  type CoverageAction,
  type ObjectRef,
  type OwnedPath,
  type RepositoryObservation,
  type ReviewLedger,
  type ReviewManifest,
} from '@factory/contract'
import { loadCodeManifestObject } from '@factory/repository'

import type {
  LoadedHistorySource,
  LoadedReviewHistory,
  PriorReview,
  ReviewHistoryLoadRequest,
  ReviewSubject,
} from './index'
import {
  isTrustedReviewRepositoryReader,
  type PortableRecordReader,
  type ReviewRepositoryReader,
} from './repository-reader'
import { subjectFingerprint } from './semantics'

export type LoadedReviewHistoryState = {
  reviews: readonly PriorReview[]
  coverageActions: readonly CoverageAction[]
  sources: readonly LoadedHistorySource[]
  validationObjects: readonly ObjectRef[]
  validationObjectsByReviewId: ReadonlyMap<string, readonly ObjectRef[]>
  reader?: ReviewRepositoryReader
}

function sameLogicalSubject(review: PriorReview, subject: ReviewSubject): boolean {
  if (review.subject.kind !== subject.kind) return false
  if (subject.kind === 'workspace')
    return (
      review.subject.kind === 'workspace' &&
      review.subject.observation.repositoryId === subject.observation.repositoryId
    )
  return (
    review.subject.kind === 'pull-request' &&
    review.subject.observation.repositoryKey === subject.observation.repositoryKey &&
    review.subject.observation.number === subject.observation.number
  )
}

function reviewRecordPaths(review: PriorReview): readonly OwnedPath[] {
  const root =
    review.subject.kind === 'workspace'
      ? ['workspace', review.reviewId]
      : [
          'pull-requests',
          'github',
          review.subject.observation.repositoryKey,
          String(review.subject.observation.number),
          review.reviewId,
        ]
  const subjectPath =
    review.subject.kind === 'workspace'
      ? makeOwnedPath('repository-observations', [
          `${review.subject.observation.observationId}.json`,
        ])
      : makeOwnedPath('pull-requests', [
          review.subject.observation.provider,
          review.subject.observation.repositoryKey,
          String(review.subject.observation.number),
          'observations',
          `${review.subject.observation.observationId}.json`,
        ])
  return [
    makeOwnedPath('reviews', [...root, 'manifest.json']),
    ...(review.disposition === 'failed'
      ? []
      : [makeOwnedPath('reviews', [...root, 'ledger.json'])]),
    subjectPath,
  ]
}

/** Select only immutable history that can influence one logical review subject. */
export function selectReviewHistory(
  history: LoadedReviewHistoryState,
  subject: ReviewSubject,
): LoadedReviewHistoryState {
  const reviews = history.reviews.filter(review => sameLogicalSubject(review, subject))
  const reviewIds = new Set(reviews.map(review => review.reviewId))
  const coverageActions = history.coverageActions.filter(action => reviewIds.has(action.reviewId))
  const paths = new Set(reviews.flatMap(reviewRecordPaths))
  for (const action of coverageActions)
    paths.add(makeOwnedPath('reviews', ['coverage-actions', `${action.actionId}.json`]))
  const validationObjects = reviews
    .flatMap(review => history.validationObjectsByReviewId.get(review.reviewId) ?? [])
    .sort(compareCanonical)
  return {
    reviews,
    coverageActions,
    sources: history.sources.filter(source => paths.has(source.path)),
    validationObjects,
    validationObjectsByReviewId: new Map(
      reviews.map(review => [
        review.reviewId,
        history.validationObjectsByReviewId.get(review.reviewId) ?? [],
      ]),
    ),
    ...(history.reader === undefined ? {} : { reader: history.reader }),
  }
}

/** Code manifests read only to validate a historical limitation-object ownership claim. */
export function deriveHistoryValidationRoots(
  sources: readonly LoadedHistorySource[],
): readonly ObjectRef[] {
  const byPath = new Map(sources.map(source => [source.path, source]))
  const roots = new Map<string, ObjectRef>()
  for (const source of sources) {
    if (source.kind !== 'review-manifest') continue
    const manifest = decodeCanonicalRecord(source.path, source.bytes) as ReviewManifest
    if (manifest.codeManifest === undefined) continue
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
    const subjectSource = byPath.get(subjectPath)
    if (subjectSource === undefined) continue
    const subject = decodeCanonicalRecord(subjectSource.path, subjectSource.bytes) as
      | RepositoryObservation
      | AvailablePullRequestObservation
    if (
      subject.codeManifest === undefined ||
      canonicalJson(subject.codeManifest) !== canonicalJson(manifest.codeManifest)
    )
      continue
    const directLimitationObjects = new Set(
      subject.limitations.flatMap(limitation =>
        limitation.object === undefined ? [] : [canonicalJson(limitation.object)],
      ),
    )
    if (
      manifest.inputProblems.some(
        problem =>
          problem.kind === 'subject-object' &&
          problem.field === 'limitation' &&
          !directLimitationObjects.has(canonicalJson(problem.object)),
      )
    )
      roots.set(canonicalJson(manifest.codeManifest), manifest.codeManifest)
  }
  return [...roots.values()].sort(compareCanonical)
}

const loadedHistories = new WeakMap<object, LoadedReviewHistoryState>()
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const compareCanonical = (left: unknown, right: unknown) =>
  canonicalJson(left).localeCompare(canonicalJson(right))
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

/** Load restart-safe review history only from validated immutable repository bytes. */
export async function loadReviewHistoryFromRequest(
  reader: PortableRecordReader,
  request: ReviewHistoryLoadRequest,
  repositoryReader?: ReviewRepositoryReader,
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
  const validationObjects = new Map<string, ObjectRef>()
  const validationObjectsByReviewId = new Map<string, Map<string, ObjectRef>>()
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
        } else if (problem.field === 'evidence') {
          return subject.observation.evidence.find(
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
      if (directReference === undefined && problem.field === 'limitation') {
        if (
          manifest.codeManifest === undefined ||
          subject.observation.codeManifest === undefined ||
          canonicalJson(manifest.codeManifest) !==
            canonicalJson(subject.observation.codeManifest) ||
          canonicalJson(problem.limitation.object) !== canonicalJson(problem.object)
        )
          throw new TypeError('history subject object problem is detached from its subject')
        const codeManifest = await loadCodeManifestObject(
          manifest.codeManifest,
          async reference => {
            const result = await reader.getObject(reference)
            if (result.kind !== 'readable')
              throw new Error(`history code manifest is ${result.kind}: ${result.detail}`)
            return new Uint8Array(result.bytes)
          },
        )
        if (
          !codeManifest.limitations.some(
            limitation => canonicalJson(limitation.object) === canonicalJson(problem.object),
          )
        )
          throw new TypeError('history limitation object is not owned by its code manifest')
        validationObjects.set(canonicalJson(manifest.codeManifest), manifest.codeManifest)
        const reviewValidationObjects =
          validationObjectsByReviewId.get(manifest.reviewId) ?? new Map<string, ObjectRef>()
        reviewValidationObjects.set(canonicalJson(manifest.codeManifest), manifest.codeManifest)
        validationObjectsByReviewId.set(manifest.reviewId, reviewValidationObjects)
      } else if (directReference === undefined) {
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
      limitations: manifest.limitations,
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
    validationObjects: [...validationObjects.values()].sort(compareCanonical),
    validationObjectsByReviewId: new Map(
      [...validationObjectsByReviewId].map(([reviewId, references]) => [
        reviewId,
        [...references.values()].sort(compareCanonical),
      ]),
    ),
    ...(repositoryReader === undefined ? {} : { reader: repositoryReader }),
  }
  const history = Object.freeze({}) as LoadedReviewHistory
  loadedHistories.set(history, state)
  return history
}

/** Load every review and coverage action visible in the same confined repository snapshot. */
export async function loadReviewHistory(
  reader: ReviewRepositoryReader,
): Promise<LoadedReviewHistory> {
  if (!isTrustedReviewRepositoryReader(reader))
    throw new TypeError('review history reader was not opened from a confined tree snapshot')
  const inventory = await reader.inventory()
  const request: ReviewHistoryLoadRequest = {
    reviews: inventory
      .filter(path => /^reviews\/(?:workspace|pull-requests\/)\S+\/manifest\.json$/.test(path))
      .map(manifestPath => ({ manifestPath })),
    coverageActionPaths: inventory.filter(path =>
      /^reviews\/coverage-actions\/[^/]+\.json$/.test(path),
    ),
  }
  return await loadReviewHistoryFromRequest(reader, request, reader)
}

/** Test-only descriptor seam; production discovers history from a confined inventory. */
export async function loadReviewHistoryForTesting(
  reader: ReviewRepositoryReader,
  request: ReviewHistoryLoadRequest,
): Promise<LoadedReviewHistory> {
  return await loadReviewHistoryFromRequest(reader, request, reader)
}

export function getLoadedReviewHistoryState(
  history: LoadedReviewHistory,
): LoadedReviewHistoryState | undefined {
  return loadedHistories.get(history)
}
