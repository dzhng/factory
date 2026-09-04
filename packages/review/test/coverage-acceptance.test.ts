import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { canonicalJson, type CoverageAction, type ReviewManifest } from '@factory/contract'
import type { RepositoryStore } from '@factory/repository'

import { acceptPartialCoverage, type PartialCoverageAcceptance } from '../src'

async function partialManifest(): Promise<ReviewManifest> {
  const root = join(import.meta.dir, '../../../specs/factory-v1/assets/review-plan')
  const bundle = JSON.parse(await readFile(join(root, 'partial-bundle/bundle.json'), 'utf8')) as {
    plan: Record<string, unknown>
  }
  const plan = bundle.plan as {
    subject: ReviewManifest['subject']
    subjectFingerprint: ReviewManifest['subjectFingerprint']
    subjectAttempt: ReviewManifest['subjectAttempt']
    sessionWatermarks: ReviewManifest['sessionWatermarks']
    coverageTargetWatermarks: ReviewManifest['coverageTargetWatermarks']
    selections: ReviewManifest['evidenceSelections']
    inputProblems: ReviewManifest['inputProblems']
    limitations: ReviewManifest['limitations']
  }
  return {
    schemaVersion: 1,
    reviewId: 'review_00000000000000000000000009',
    subject: plan.subject,
    patches: [],
    sessionWatermarks: plan.sessionWatermarks,
    coverageTargetWatermarks: plan.coverageTargetWatermarks,
    subjectFingerprint: plan.subjectFingerprint,
    subjectAttempt: plan.subjectAttempt,
    evidenceSelections: plan.selections,
    inputProblems: plan.inputProblems,
    triggerIds: [],
    associationBatchIds: [],
    limitations: [
      ...plan.limitations,
      { code: 'invalid-review-output', detail: 'incomplete reviewer output' },
    ],
    reviewer: { provider: 'codex', model: 'fake', effort: 'high' },
    analyzerVersion: 'test',
    promptVersion: 'test',
    policyVersion: 'test',
    formatVersion: 1,
    bundleSha256: 'a'.repeat(64) as ReviewManifest['bundleSha256'],
    containerImageDigest: `sha256:${'b'.repeat(64)}`,
    providerCliVersion: 'fake',
    hostPlatform: 'linux/arm64',
    startedAt: '2026-09-05T00:00:00Z',
    completedAt: '2026-09-05T00:00:01Z',
    disposition: 'partial',
  }
}

function requestFor(review: ReviewManifest): PartialCoverageAcceptance {
  return {
    reviewId: review.reviewId,
    subject: review.subject,
    acceptedLimitations: ['invalid-review-output', 'missing-transcript-range'],
    acceptedTriggerIds: [],
    acceptedProblemIds: [],
    acceptedSubject: {
      fingerprint: review.subjectAttempt.fingerprint,
      coverageId: review.subjectAttempt.coverageId,
      limitations: [],
    },
    settledWatermarks: review.coverageTargetWatermarks,
  }
}

function storeFor(review?: ReviewManifest) {
  let action: CoverageAction | undefined
  const store = {
    async readRecords() {
      return {
        records:
          review === undefined
            ? []
            : [
                {
                  path: `reviews/workspace/${review.reviewId}/manifest.json`,
                  value: review,
                },
              ],
      }
    },
    async createImmutable(_path: string, bytes: Uint8Array) {
      action = JSON.parse(new TextDecoder().decode(bytes)) as CoverageAction
      return { path: _path, sha256: '', bytes: bytes.byteLength }
    },
  } as unknown as RepositoryStore
  return { store, readAction: () => action }
}

describe('partial review coverage acceptance', () => {
  test('derives a deterministic action only after exact acknowledgement', async () => {
    const review = await partialManifest()
    const first = storeFor(review)
    const second = storeFor(review)
    const path = await acceptPartialCoverage(first.store, requestFor(review))
    await acceptPartialCoverage(second.store, requestFor(review))

    expect(first.readAction()).toEqual(second.readAction())
    expect(path).toEndWith(`${first.readAction()!.actionId}.json`)
    expect(first.readAction()!.createdAt).toBe(review.completedAt)
  })

  test('rejects unknown, non-partial, wrong-subject, and incomplete acknowledgements', async () => {
    const review = await partialManifest()
    await expect(acceptPartialCoverage(storeFor().store, requestFor(review))).rejects.toThrow(
      'no unique review',
    )
    await expect(
      acceptPartialCoverage(
        storeFor({ ...review, disposition: 'complete' }).store,
        requestFor(review),
      ),
    ).rejects.toThrow('requires a partial review')
    await expect(
      acceptPartialCoverage(storeFor(review).store, {
        ...requestFor(review),
        subject: { kind: 'workspace', repositoryObservationId: 'observation_wrong' },
      }),
    ).rejects.toThrow('wrong subject')
    await expect(
      acceptPartialCoverage(storeFor(review).store, {
        ...requestFor(review),
        acceptedLimitations: ['missing-transcript-range'],
      }),
    ).rejects.toThrow('exact partial review gaps')
    expect(canonicalJson(requestFor(review))).toContain('invalid-review-output')
  })
})
