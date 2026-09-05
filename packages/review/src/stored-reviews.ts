import {
  canonicalJson,
  type OwnedPath,
  type RecordId,
  type ReviewManifest,
} from '@factory/contract'
import type { StoredReview } from '@factory/domain'
import type { RepositoryStore } from '@factory/repository'

type RepositoryRecords = Awaited<ReturnType<RepositoryStore['readRecords']>>['records']
export type ReviewFindingThreshold = 'low' | 'medium' | 'high' | 'critical'

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
