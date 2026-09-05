import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ReviewManifest } from '@factory/contract'
import { withAdvisoryFileLock } from '@factory/repository'

import { openVerifiedReviewBundle, readReviewerRawAttempt } from '../src'
import { sealReviewerRawAttempt } from '../src/attempt'
import { ReviewAttemptCoordinator } from '../src/coordinator'

async function fixture() {
  const root = join(import.meta.dir, '../../../specs/factory-v1/assets/review-plan')
  const report = await Bun.file(join(root, 'report.json')).json()
  const bundle = await openVerifiedReviewBundle(
    join(root, 'complete-bundle'),
    report.bundles.complete,
  )
  return { bundle, sha256: report.bundles.complete as string }
}

describe('review attempt coordinator', () => {
  test('skips unrelated active attempts and rejects linked runtime roots', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'factory-review-attempt-'))
    await ReviewAttemptCoordinator.open({ testRuntimeRoot: runtime })
    const attempts = join(runtime, 'review-attempts-v1')
    const active = join(attempts, 'a'.repeat(64))
    await mkdir(active)
    const started = performance.now()
    await withAdvisoryFileLock(join(active, 'attempt.lock'), 1_000, async () => {
      await ReviewAttemptCoordinator.open({ testRuntimeRoot: runtime })
    })
    expect(performance.now() - started).toBeLessThan(250)

    const target = await mkdtemp(join(tmpdir(), 'factory-review-attempt-target-'))
    await symlink(target, join(attempts, 'b'.repeat(64)))
    await expect(ReviewAttemptCoordinator.open({ testRuntimeRoot: runtime })).rejects.toThrow(
      'not an ordinary directory',
    )
  })

  test('singleflights one logical attempt and reuses its stable identity', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'factory-review-attempt-'))
    const coordinator = await ReviewAttemptCoordinator.open({ testRuntimeRoot: runtime })
    const { bundle, sha256 } = await fixture()
    const choice = { settings: { provider: 'codex' as const, model: 'gpt-test', effort: 'high' } }
    let executions = 0
    const executor = {
      async run(_bundle: unknown, reviewer: typeof choice, input: { reviewId: string }) {
        executions += 1
        return sealReviewerRawAttempt({
          reviewId: input.reviewId as `review_${string}`,
          bundleSha256: sha256,
          response: new TextEncoder().encode('private provider response'),
          termination: 'completed',
          exitCode: 0,
          outputTruncated: false,
          reviewer,
          imageDigest: `sha256:${'b'.repeat(64)}`,
          providerCliVersion: 'fake-1',
          hostPlatform: 'linux/arm64',
          startedAt: '2026-09-05T00:00:00Z',
          completedAt: '2026-09-05T00:00:01Z',
        })
      },
    }
    const input = {
      imageReference: `sha256:${'b'.repeat(64)}`,
      imageDigest: `sha256:${'b'.repeat(64)}`,
      timeoutMs: 100,
    }
    const [first, second] = await Promise.all([
      coordinator.run(bundle, choice, executor, input),
      coordinator.run(bundle, choice, executor, input),
    ])
    expect(executions).toBe(1)
    expect(readReviewerRawAttempt(first)).toEqual(readReviewerRawAttempt(second))
    const attemptsRoot = join(runtime, 'review-attempts-v1')
    const [attemptKey] = await readdir(attemptsRoot)
    const statePath = join(attemptsRoot, attemptKey!, 'state.json')
    expect(await readFile(statePath, 'utf8')).toContain('responseBase64')
    await coordinator.finalize(bundle, choice, input.imageDigest, {
      reviewId: readReviewerRawAttempt(first).reviewId,
    })
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(executions).toBe(1)
  })

  test('advances beyond an accepted execution failure with durable retry history', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'factory-review-attempt-'))
    const coordinator = await ReviewAttemptCoordinator.open({ testRuntimeRoot: runtime })
    const { bundle, sha256 } = await fixture()
    const choice = { settings: { provider: 'codex' as const, model: 'gpt-test', effort: 'high' } }
    let executions = 0
    const executor = {
      async run(_bundle: unknown, reviewer: typeof choice, input: { reviewId: string }) {
        executions += 1
        return sealReviewerRawAttempt({
          reviewId: input.reviewId as `review_${string}`,
          bundleSha256: sha256,
          response: new Uint8Array(),
          termination: 'docker-unavailable' as const,
          exitCode: null,
          outputTruncated: false,
          reviewer,
          imageDigest: `sha256:${'b'.repeat(64)}`,
          providerCliVersion: null,
          hostPlatform: 'linux/arm64',
          startedAt: '2026-09-05T00:00:00Z',
          completedAt: '2026-09-05T00:00:01Z',
        })
      },
    }
    const input = {
      imageReference: `sha256:${'b'.repeat(64)}`,
      imageDigest: `sha256:${'b'.repeat(64)}`,
      timeoutMs: 100,
    }
    const failed = await coordinator.run(bundle, choice, executor, input)
    const failedId = readReviewerRawAttempt(failed).reviewId
    await coordinator.finalize(bundle, choice, input.imageDigest, {
      reviewId: failedId,
    })
    const retried = await coordinator.run(bundle, choice, executor, {
      ...input,
      retryGeneration: failedId,
    })
    expect(readReviewerRawAttempt(retried).reviewId).not.toBe(failedId)
    expect(executions).toBe(2)
  })

  test('reconciles duplicate review IDs by exact durable attempt facts', async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'factory-review-attempt-'))
    const coordinator = await ReviewAttemptCoordinator.open({ testRuntimeRoot: runtime })
    const { bundle, sha256 } = await fixture()
    const choice = { settings: { provider: 'codex' as const, model: 'gpt-test', effort: 'high' } }
    const imageDigest = `sha256:${'b'.repeat(64)}`
    const attempt = await coordinator.run(
      bundle,
      choice,
      {
        async run(_bundle, reviewer, input) {
          return sealReviewerRawAttempt({
            reviewId: input.reviewId,
            bundleSha256: sha256,
            response: new Uint8Array(),
            termination: 'completed',
            exitCode: 0,
            outputTruncated: false,
            reviewer,
            imageDigest,
            providerCliVersion: 'fake-1',
            hostPlatform: 'linux/arm64',
            startedAt: '2026-09-05T00:00:00Z',
            completedAt: '2026-09-05T00:00:01Z',
          })
        },
      },
      { imageReference: imageDigest, imageDigest, timeoutMs: 100 },
    )
    const reviewId = readReviewerRawAttempt(attempt).reviewId
    const base = {
      reviewId,
      reviewer: choice.settings,
      containerImageDigest: imageDigest,
      disposition: 'complete',
      limitations: [],
    } as unknown as ReviewManifest
    await coordinator.reconcileAccepted([
      { ...base, bundleSha256: 'a'.repeat(64) },
      { ...base, bundleSha256: sha256 },
    ])
    expect(await readdir(join(runtime, 'review-attempts-v1'))).toEqual([])
  })
})
