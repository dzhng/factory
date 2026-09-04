import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
          response: new Uint8Array(),
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
      imageDigest: `sha256:${'b'.repeat(64)}`,
      auth: [],
      timeoutMs: 100,
    }
    const [first, second] = await Promise.all([
      coordinator.run(bundle, choice, executor, input),
      coordinator.run(bundle, choice, executor, input),
    ])
    expect(executions).toBe(1)
    expect(readReviewerRawAttempt(first)).toEqual(readReviewerRawAttempt(second))
  })
})
