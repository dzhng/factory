import { dirname } from 'node:path'

import {
  canonicalJson,
  type AvailablePullRequestObservation,
  type OwnedPath,
  type RepositoryRecords,
  type RepositoryObservation,
  type ReviewLedger,
  type ReviewManifest,
} from '@factory/contract'

import type { CoverageSubject } from './coverage'

export type StoredReview = {
  manifest: ReviewManifest
  subject?: CoverageSubject
  lineage: string
  paths: { manifest: OwnedPath; submissions: OwnedPath; ledger?: OwnedPath }
  submissions: string
  ledger?: ReviewLedger
}

function reviewSubject(
  review: ReviewManifest,
  byPath: ReadonlyMap<OwnedPath, unknown>,
): CoverageSubject {
  if (review.subject.kind === 'pull-request') {
    const observation = byPath.get(
      `pull-requests/${review.subject.provider}/${review.subject.repositoryKey}/${review.subject.number}/observations/${review.subject.observationId}.json` as OwnedPath,
    )
    if (typeof observation !== 'object' || observation === null || Array.isArray(observation))
      throw new Error('stored pull-request review does not resolve to its subject')
    return { kind: 'pull-request', observation: observation as AvailablePullRequestObservation }
  }
  const observation = byPath.get(
    `repository-observations/${review.subject.repositoryObservationId}.json` as OwnedPath,
  )
  if (typeof observation !== 'object' || observation === null || Array.isArray(observation))
    throw new Error('stored workspace review does not resolve to its subject')
  return { kind: 'workspace', observation: observation as RepositoryObservation }
}

export function resolveStoredReviewSubject(
  review: ReviewManifest,
  records: RepositoryRecords,
): CoverageSubject {
  return reviewSubject(review, new Map(records.records.map(record => [record.path, record.value])))
}

function storedReviewLineage(
  review: ReviewManifest,
  byPath: ReadonlyMap<OwnedPath, unknown>,
): string {
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

/** Index every exact manifest-last review group for all domain projections and services. */
export function loadStoredReviews(records: RepositoryRecords['records']): StoredReview[] {
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
    const submissionsPath = `${root}/submissions.jsonl` as OwnedPath
    const ledgerPath = `${root}/ledger.json` as OwnedPath
    const expected = [manifestRecord.path, submissionsPath]
    if (manifest.disposition !== 'failed') expected.push(ledgerPath)
    if (canonicalJson(group.map(record => record.path).sort()) !== canonicalJson(expected.sort()))
      throw new Error('stored review does not have an exact committed record group')
    const submissions = byPath.get(submissionsPath)
    if (typeof submissions !== 'string') throw new Error('stored review submissions is absent')
    const ledger =
      manifest.disposition === 'failed'
        ? undefined
        : (byPath.get(ledgerPath) as ReviewLedger | undefined)
    if (manifest.disposition !== 'failed' && ledger?.reviewId !== manifest.reviewId)
      throw new Error('stored review ledger does not match its manifest')
    let subject: CoverageSubject | undefined
    try {
      subject = reviewSubject(manifest, byPath)
    } catch {
      subject = undefined
    }
    reviews.push({
      manifest,
      ...(subject === undefined ? {} : { subject }),
      lineage: storedReviewLineage(manifest, byPath),
      paths: {
        manifest: manifestRecord.path,
        submissions: submissionsPath,
        ...(manifest.disposition === 'failed' ? {} : { ledger: ledgerPath }),
      },
      submissions,
      ...(ledger === undefined ? {} : { ledger }),
    })
  }
  return reviews.sort((left, right) => left.paths.manifest.localeCompare(right.paths.manifest))
}
