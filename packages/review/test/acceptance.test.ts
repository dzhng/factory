import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { canonicalJson, type ReviewManifest } from '@factory/contract'
import type { RepositoryStore } from '@factory/repository'
import { openVerifiedReviewBundle, readVerifiedReviewBundle } from '@factory/reviewer'

import { sealReviewerRawAttempt } from '../../reviewer/src/attempt'
import { acceptReview, validateReview, type RawAttempt } from '../src'

const reviewId = 'review_00000000000000000000000009' as const
const at = '2026-09-05T00:00:00Z'

async function fixture() {
  const root = join(import.meta.dir, '../../../specs/factory-v1/assets/review-plan')
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as {
    bundles: { complete: string; partial: string }
  }
  const path = join(root, 'complete-bundle')
  const bundle = await openVerifiedReviewBundle(path, report.bundles.complete)
  const manifest = JSON.parse(await readFile(join(path, 'bundle.json'), 'utf8')) as {
    inventory: unknown[]
    plan: { policies: { reviewer: { provider: 'codex'; model: string; effort: string } } }
  }
  return { bundle, manifest }
}

async function partialFixture() {
  const root = join(import.meta.dir, '../../../specs/factory-v1/assets/review-plan')
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as {
    bundles: { partial: string }
  }
  const path = join(root, 'partial-bundle')
  const bundle = await openVerifiedReviewBundle(path, report.bundles.partial)
  const manifest = JSON.parse(await readFile(join(path, 'bundle.json'), 'utf8')) as {
    inventory: unknown[]
    plan: { policies: { reviewer: { provider: 'codex'; model: string; effort: string } } }
  }
  return { bundle, manifest }
}

async function authorizedStore(
  bundle: Awaited<ReturnType<typeof openVerifiedReviewBundle>>,
  methods: Record<string, unknown>,
): Promise<RepositoryStore> {
  const verified = await readVerifiedReviewBundle(bundle)
  return {
    manifest: { repositoryId: verified.authority.repositoryId ?? 'repo_review_lab' },
    async readImmutable() {
      return new TextEncoder().encode(canonicalJson(verified.authority.subjectRecord))
    },
    async getObject() {
      return new Uint8Array()
    },
    ...methods,
  } as unknown as RepositoryStore
}

describe('immutable review acceptance', () => {
  test('rejects forged attempts and a target repository outside the bundle authority', async () => {
    const { bundle, manifest: bundleManifest } = await fixture()
    await expect(validateReview(bundle, {} as RawAttempt)).rejects.toThrow(
      'attempt capability is not verified',
    )
    const citation = bundleManifest.inventory[0]
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        reviewId,
        response: new TextEncoder().encode(
          `${JSON.stringify({ kind: 'summary', summary: 'Review completed', evidence: [{ object: citation }] })}\n`,
        ),
        termination: 'completed',
        exitCode: 0,
        outputTruncated: false,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
    )
    const store = await authorizedStore(bundle, {
      manifest: { repositoryId: 'repo_elsewhere' },
      async publishImmutableGroup() {
        throw new Error('must not publish')
      },
    })
    await expect(acceptReview(validated, store)).rejects.toThrow('different repository')
  })

  test('derives a complete manifest and ledger from cited semantic output', async () => {
    const { bundle, manifest: bundleManifest } = await fixture()
    const citation = bundleManifest.inventory[0]
    const response = new TextEncoder().encode(
      `${JSON.stringify({ kind: 'summary', summary: 'Review completed', evidence: [{ object: citation }] })}\n`,
    )
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        reviewId,
        response,
        termination: 'completed',
        exitCode: 0,
        outputTruncated: false,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
    )
    let published:
      | { records: readonly { path: string; bytes: Uint8Array }[]; commitPath: string }
      | undefined
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup(
        records: readonly { path: string; bytes: Uint8Array }[],
        commitPath: string,
      ) {
        published = { records, commitPath }
        return { path: commitPath, sha256: '', bytes: 0 }
      },
    })
    const accepted = await acceptReview(validated, store)
    const manifestRecord = published!.records.find(record => record.path.endsWith('manifest.json'))!
    const review = JSON.parse(new TextDecoder().decode(manifestRecord.bytes)) as ReviewManifest

    expect(accepted).toMatchObject({ disposition: 'complete', executionFailed: false })
    expect(published!.commitPath).toBe(manifestRecord.path)
    expect(published!.records.map(record => record.path)).toEqual([
      `reviews/workspace/${reviewId}/response.txt`,
      `reviews/workspace/${reviewId}/ledger.json`,
      `reviews/workspace/${reviewId}/manifest.json`,
    ])
    expect(review.reviewer).toEqual(bundleManifest.plan.policies.reviewer)
    expect(review.bundleSha256).toHaveLength(64)
    expect(canonicalJson(review.limitations)).toBe(canonicalJson([]))
  })

  test('salvages a valid prefix as partial and reports execution failure separately', async () => {
    const { bundle, manifest: bundleManifest } = await fixture()
    const response = new TextEncoder().encode(
      `${JSON.stringify({ kind: 'summary', summary: 'Useful prefix', evidence: [{ object: bundleManifest.inventory[0] }] })}\n{"bad"`,
    )
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        reviewId,
        response,
        termination: 'timed-out',
        exitCode: null,
        outputTruncated: true,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
    )
    let manifest: ReviewManifest | undefined
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        const record = records.find(item => item.path.endsWith('manifest.json'))!
        manifest = JSON.parse(new TextDecoder().decode(record.bytes)) as ReviewManifest
        return { path: record.path, sha256: '', bytes: 0 }
      },
    })
    const accepted = await acceptReview(validated, store)

    expect(accepted).toMatchObject({ disposition: 'partial', executionFailed: true })
    expect(manifest!.subjectAttempt.effect).toBe('reviewed-partial')
    expect(manifest!.limitations).toContainEqual({
      code: 'invalid-review-output',
      detail: 'Reviewer execution or semantic output was incomplete',
    })
  })

  test('keeps valid subject coverage when only selected session input is partial', async () => {
    const { bundle, manifest: bundleManifest } = await partialFixture()
    const response = new TextEncoder().encode(
      `${JSON.stringify({ kind: 'summary', summary: 'Reviewed available evidence', evidence: [{ object: bundleManifest.inventory[0] }] })}\n`,
    )
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        reviewId,
        response,
        termination: 'completed',
        exitCode: 0,
        outputTruncated: false,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
    )
    let manifest: ReviewManifest | undefined
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        const record = records.find(item => item.path.endsWith('manifest.json'))!
        manifest = JSON.parse(new TextDecoder().decode(record.bytes)) as ReviewManifest
        return { path: record.path, sha256: '', bytes: 0 }
      },
    })
    await acceptReview(validated, store)

    expect(manifest!.disposition).toBe('partial')
    expect(manifest!.subjectAttempt.effect).toBe('current-included')
  })

  test('publishes only the bounded valid UTF-8 response prefix', async () => {
    const { bundle, manifest: bundleManifest } = await fixture()
    const prefix = new TextEncoder().encode(
      `${JSON.stringify({ kind: 'summary', summary: 'Useful prefix', evidence: [{ object: bundleManifest.inventory[0] }] })}\n`,
    )
    const response = new Uint8Array(2 * 1024 * 1024)
    response.set(prefix)
    response[prefix.byteLength] = 0xff
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        reviewId,
        response,
        termination: 'completed',
        exitCode: 0,
        outputTruncated: false,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
    )
    let publishedResponse: Uint8Array | undefined
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        publishedResponse = records.find(item => item.path.endsWith('response.txt'))!.bytes
        const record = records.find(item => item.path.endsWith('manifest.json'))!
        return { path: record.path, sha256: '', bytes: 0 }
      },
    })
    const accepted = await acceptReview(validated, store)

    expect(publishedResponse).toEqual(prefix)
    expect(publishedResponse!.byteLength).toBeLessThanOrEqual(1024 * 1024)
    expect(accepted).toMatchObject({ disposition: 'partial', executionFailed: true })
  })
})
