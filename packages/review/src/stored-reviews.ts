import { dirname } from 'node:path'

import {
  canonicalJson,
  type OwnedPath,
  type RecordId,
  type ReviewLedger,
  type ReviewManifest,
} from '@factory/contract'
import type { RepositoryStore } from '@factory/repository'

type RepositoryRecords = Awaited<ReturnType<RepositoryStore['readRecords']>>['records']
export type ReviewFindingThreshold = 'low' | 'medium' | 'high' | 'critical'

export type StoredReview = {
  manifest: ReviewManifest
  lineage: string
  paths: { manifest: OwnedPath; response: OwnedPath; ledger?: OwnedPath }
  ledger?: ReviewLedger
}

export type StoredReviewResult = {
  schemaVersion: 1
  status?: 'already-reviewed'
  reviewId: RecordId
  disposition: ReviewManifest['disposition']
  limitations: ReviewManifest['limitations']
  reviewer: ReviewManifest['reviewer'] & { version: string | null }
  coverageEffect: ReviewManifest['subjectAttempt']['effect']
  paths: StoredReview['paths']
  executionFailed: boolean
}

function reviewLineage(review: ReviewManifest, byPath: ReadonlyMap<OwnedPath, unknown>): string {
  if (review.subject.kind === 'pull-request')
    return canonicalJson({
      kind: review.subject.kind,
      repositoryKey: review.subject.repositoryKey,
      number: review.subject.number,
    })
  const observation = byPath.get(
    `repository-observations/${review.subject.repositoryObservationId}.json` as OwnedPath,
  )
  if (
    typeof observation !== 'object' ||
    observation === null ||
    Array.isArray(observation) ||
    !('repositoryId' in observation) ||
    typeof observation.repositoryId !== 'string'
  )
    throw new Error('stored workspace review does not resolve to its subject lineage')
  return canonicalJson({ kind: review.subject.kind, repositoryId: observation.repositoryId })
}

/** Index and validate every exact manifest-last review group in one linear pass. */
export function loadStoredReviews(records: RepositoryRecords): StoredReview[] {
  const byPath = new Map<OwnedPath, unknown>()
  const groups = new Map<string, (typeof records)[number][]>()
  for (const record of records) {
    byPath.set(record.path, record.value)
    if (!record.path.startsWith('reviews/')) continue
    const root = dirname(record.path)
    const group = groups.get(root)
    if (group === undefined) groups.set(root, [record])
    else group.push(record)
  }

  const reviews: StoredReview[] = []
  for (const [root, group] of groups) {
    const manifestRecord = group.find(record => record.path === `${root}/manifest.json`)
    if (manifestRecord === undefined) continue
    const manifest = manifestRecord.value as unknown as ReviewManifest
    const responsePath = `${root}/response.txt` as OwnedPath
    const ledgerPath = `${root}/ledger.json` as OwnedPath
    const expected = [manifestRecord.path, responsePath]
    if (manifest.disposition !== 'failed') expected.push(ledgerPath)
    if (canonicalJson(group.map(record => record.path).sort()) !== canonicalJson(expected.sort()))
      throw new Error('stored review does not have an exact committed record group')
    const ledger =
      manifest.disposition === 'failed'
        ? undefined
        : (byPath.get(ledgerPath) as ReviewLedger | undefined)
    if (manifest.disposition !== 'failed' && ledger?.reviewId !== manifest.reviewId)
      throw new Error('stored review ledger does not match its manifest')
    reviews.push({
      manifest,
      lineage: reviewLineage(manifest, byPath),
      paths: {
        manifest: manifestRecord.path,
        response: responsePath,
        ...(manifest.disposition === 'failed' ? {} : { ledger: ledgerPath }),
      },
      ...(ledger === undefined ? {} : { ledger }),
    })
  }
  return reviews.sort((left, right) => left.paths.manifest.localeCompare(right.paths.manifest))
}

export function storedReviewResult(
  review: StoredReview,
  status?: 'already-reviewed',
): StoredReviewResult {
  const manifest = review.manifest
  return {
    schemaVersion: 1,
    ...(status === undefined ? {} : { status }),
    reviewId: manifest.reviewId,
    disposition: manifest.disposition,
    limitations: manifest.limitations,
    reviewer: { ...manifest.reviewer, version: manifest.providerCliVersion },
    coverageEffect: manifest.subjectAttempt.effect,
    paths: review.paths,
    executionFailed:
      manifest.disposition === 'failed' ||
      manifest.limitations.some(item => item.code === 'invalid-review-output'),
  }
}

export function subjectPathLineage(path: OwnedPath, records: RepositoryRecords): string {
  const subject = new Map(records.map(record => [record.path, record.value])).get(path)
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject))
    throw new Error('selected review subject is absent')
  if (path.startsWith('repository-observations/')) {
    if (!('repositoryId' in subject) || typeof subject.repositoryId !== 'string')
      throw new Error('selected workspace subject has no repository lineage')
    return canonicalJson({ kind: 'workspace', repositoryId: subject.repositoryId })
  }
  if (
    !('repositoryKey' in subject) ||
    typeof subject.repositoryKey !== 'string' ||
    !('number' in subject) ||
    typeof subject.number !== 'number'
  )
    throw new Error('selected pull-request subject has no repository lineage')
  return canonicalJson({
    kind: 'pull-request',
    repositoryKey: subject.repositoryKey,
    number: subject.number,
  })
}

export function storedReviewFindingsMeetThreshold(
  review: StoredReview,
  threshold: ReviewFindingThreshold | undefined,
): boolean {
  if (threshold === undefined || review.ledger === undefined) return false
  const ranks = { low: 1, medium: 2, high: 3, critical: 4 } as const
  return review.ledger.entries.some(
    entry => entry.kind === 'finding' && ranks[entry.severity] >= ranks[threshold],
  )
}
