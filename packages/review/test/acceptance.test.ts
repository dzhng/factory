import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { canonicalJson, type ReviewManifest } from '@factory/contract'
import type { RepositoryStore } from '@factory/repository'
import { openVerifiedReviewBundle } from '@factory/reviewer'

import { acceptReview, validateReview } from '../src'

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

describe('immutable review acceptance', () => {
  test('derives a complete manifest and ledger from cited semantic output', async () => {
    const { bundle, manifest: bundleManifest } = await fixture()
    const citation = bundleManifest.inventory[0]
    const response = new TextEncoder().encode(
      `${JSON.stringify({ kind: 'summary', summary: 'Review completed', evidence: [{ object: citation }] })}\n`,
    )
    const validated = await validateReview(bundle, {
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
    })
    let published:
      | { records: readonly { path: string; bytes: Uint8Array }[]; commitPath: string }
      | undefined
    const store = {
      async publishImmutableGroup(
        records: readonly { path: string; bytes: Uint8Array }[],
        commitPath: string,
      ) {
        published = { records, commitPath }
        return { path: commitPath, sha256: '', bytes: 0 }
      },
    } as unknown as RepositoryStore
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
    const validated = await validateReview(bundle, {
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
    })
    let manifest: ReviewManifest | undefined
    const store = {
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        const record = records.find(item => item.path.endsWith('manifest.json'))!
        manifest = JSON.parse(new TextDecoder().decode(record.bytes)) as ReviewManifest
        return { path: record.path, sha256: '', bytes: 0 }
      },
    } as unknown as RepositoryStore
    const accepted = await acceptReview(validated, store)

    expect(accepted).toMatchObject({ disposition: 'partial', executionFailed: true })
    expect(manifest!.subjectAttempt.effect).toBe('reviewed-partial')
    expect(manifest!.limitations).toContainEqual({
      code: 'invalid-review-output',
      detail: 'Reviewer execution or semantic output was incomplete',
    })
  })
})
