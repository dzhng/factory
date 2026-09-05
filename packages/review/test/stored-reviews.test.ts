import { describe, expect, test } from 'bun:test'

import {
  newRecordId,
  type OwnedPath,
  type ReviewLedger,
  type ReviewManifest,
} from '@factory/contract'
import { loadStoredReviews } from '@factory/domain'

import { storedReviewFindingsMeetThreshold } from '../src'

function review(
  reviewId: ReviewManifest['reviewId'],
  subject: ReviewManifest['subject'],
): ReviewManifest {
  return {
    reviewId,
    subject,
    disposition: 'complete',
    limitations: [],
    reviewer: { provider: 'codex', model: 'test', effort: 'high' },
    providerCliVersion: 'test',
    subjectAttempt: {
      effect: 'reviewed',
      fingerprint: 'a'.repeat(64),
      coverageId: 'b'.repeat(64),
      limitations: [],
    },
  } as unknown as ReviewManifest
}

function group(manifest: ReviewManifest, ledger: ReviewLedger) {
  const root =
    manifest.subject.kind === 'workspace'
      ? `reviews/workspace/${manifest.reviewId}`
      : `reviews/pull-requests/github/${manifest.subject.repositoryKey}/${manifest.subject.number}/${manifest.reviewId}`
  return [
    { path: `${root}/response.txt` as OwnedPath, value: '' },
    { path: `${root}/ledger.json` as OwnedPath, value: ledger },
    { path: `${root}/manifest.json` as OwnedPath, value: manifest },
  ]
}

describe('stored review projection', () => {
  test('binds findings to the exact committed review root when IDs collide', () => {
    const reviewId = newRecordId('review')
    const workspace = review(reviewId, {
      kind: 'workspace',
      repositoryObservationId: newRecordId('observation'),
    })
    const pullRequest = review(reviewId, {
      kind: 'pull-request',
      provider: 'github',
      repositoryKey: 'github.com/R_other',
      number: 42,
      observationId: newRecordId('observation'),
    })
    const records = [
      {
        path: `repository-observations/${workspace.subject.kind === 'workspace' ? workspace.subject.repositoryObservationId : ''}.json` as OwnedPath,
        value: { repositoryId: 'repo_workspace' },
      },
      ...group(workspace, {
        schemaVersion: 1,
        reviewId,
        entries: [{ kind: 'finding', severity: 'low' } as never],
      }),
      ...group(pullRequest, {
        schemaVersion: 1,
        reviewId,
        entries: [{ kind: 'finding', severity: 'critical' } as never],
      }),
    ] as Parameters<typeof loadStoredReviews>[0]

    const stored = loadStoredReviews(records)
    const workspaceReview = stored.find(item => item.manifest.subject.kind === 'workspace')!
    const pullRequestReview = stored.find(item => item.manifest.subject.kind === 'pull-request')!
    expect(storedReviewFindingsMeetThreshold(workspaceReview, 'high')).toBeFalse()
    expect(storedReviewFindingsMeetThreshold(pullRequestReview, 'high')).toBeTrue()
  })

  test('indexes many committed groups without rescanning the repository per review', () => {
    const records = Array.from({ length: 2_000 }, (_, number) => {
      const reviewId = newRecordId('review')
      const manifest = review(reviewId, {
        kind: 'pull-request',
        provider: 'github',
        repositoryKey: 'github.com/R_many',
        number: number + 1,
        observationId: newRecordId('observation'),
      })
      return group(manifest, { schemaVersion: 1, reviewId, entries: [] })
    }).flat() as Parameters<typeof loadStoredReviews>[0]

    expect(loadStoredReviews(records)).toHaveLength(2_000)
  })
})
