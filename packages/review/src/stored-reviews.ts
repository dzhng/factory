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

export type StoredReviewResult = {
  schemaVersion: 1
  status?: 'already-reviewed'
  reviewId: RecordId
  disposition: ReviewManifest['disposition']
  limitations: ReviewManifest['limitations']
  reviewer: ReviewManifest['reviewer'] & { version: string | null }
  coverageEffect: ReviewManifest['subjectAttempt']['effect']
  paths: { manifest: string; response: string; ledger?: string }
  executionFailed: boolean
}

/** Load only review manifests whose exact immutable record group is committed. */
export function committedReviewManifests(records: RepositoryRecords): ReviewManifest[] {
  return records
    .filter(record => /^reviews\/.*\/manifest\.json$/.test(record.path))
    .map(record => {
      const review = record.value as unknown as ReviewManifest
      const root = dirname(record.path)
      const siblings = records
        .filter(candidate => dirname(candidate.path) === root)
        .map(candidate => candidate.path)
        .sort()
      const expected = [record.path, `${root}/response.txt`]
      if (review.disposition !== 'failed') expected.push(`${root}/ledger.json`)
      if (canonicalJson(siblings) !== canonicalJson(expected.sort()))
        throw new Error('stored review does not have an exact committed record group')
      return review
    })
}

/** Project exact committed paths and review outcome for user-facing clients. */
export function storedReviewResult(
  review: ReviewManifest,
  status?: 'already-reviewed',
): StoredReviewResult {
  const root =
    review.subject.kind === 'workspace'
      ? `reviews/workspace/${review.reviewId}`
      : `reviews/pull-requests/github/${review.subject.repositoryKey}/${review.subject.number}/${review.reviewId}`
  return {
    schemaVersion: 1,
    ...(status === undefined ? {} : { status }),
    reviewId: review.reviewId,
    disposition: review.disposition,
    limitations: review.limitations,
    reviewer: { ...review.reviewer, version: review.providerCliVersion },
    coverageEffect: review.subjectAttempt.effect,
    paths: {
      manifest: `${root}/manifest.json`,
      response: `${root}/response.txt`,
      ...(review.disposition === 'failed' ? {} : { ledger: `${root}/ledger.json` }),
    },
    executionFailed:
      review.disposition === 'failed' ||
      review.limitations.some(item => item.code === 'invalid-review-output'),
  }
}

export function reviewSubjectLineage(review: ReviewManifest, records: RepositoryRecords): string {
  const subject = review.subject
  if (subject.kind === 'pull-request')
    return canonicalJson({
      kind: subject.kind,
      repositoryKey: subject.repositoryKey,
      number: subject.number,
    })
  const observation = records.find(
    record => record.path === `repository-observations/${subject.repositoryObservationId}.json`,
  )?.value
  if (
    typeof observation !== 'object' ||
    observation === null ||
    Array.isArray(observation) ||
    typeof observation.repositoryId !== 'string'
  )
    throw new Error('stored workspace review does not resolve to its subject lineage')
  return canonicalJson({ kind: subject.kind, repositoryId: observation.repositoryId })
}

export function subjectPathLineage(path: OwnedPath, records: RepositoryRecords): string {
  const subject = records.find(record => record.path === path)?.value
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject))
    throw new Error('selected review subject is absent')
  if (path.startsWith('repository-observations/')) {
    if (typeof subject.repositoryId !== 'string')
      throw new Error('selected workspace subject has no repository lineage')
    return canonicalJson({ kind: 'workspace', repositoryId: subject.repositoryId })
  }
  if (typeof subject.repositoryKey !== 'string' || typeof subject.number !== 'number')
    throw new Error('selected pull-request subject has no repository lineage')
  return canonicalJson({
    kind: 'pull-request',
    repositoryKey: subject.repositoryKey,
    number: subject.number,
  })
}

export async function reviewFindingsMeetThreshold(
  store: RepositoryStore,
  reviewId: RecordId,
  threshold: ReviewFindingThreshold | undefined,
): Promise<boolean> {
  if (threshold === undefined) return false
  const match = (await store.readRecords()).records.find(record =>
    record.path.endsWith(`/${reviewId}/ledger.json`),
  )
  if (match === undefined) return false
  const ledger = match.value as unknown as ReviewLedger
  const ranks = { low: 1, medium: 2, high: 3, critical: 4 } as const
  return ledger.entries.some(
    entry => entry.kind === 'finding' && ranks[entry.severity] >= ranks[threshold],
  )
}
