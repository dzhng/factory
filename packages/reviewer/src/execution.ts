import { constants } from 'node:fs'
import { chmod, mkdtemp, open, rm } from 'node:fs/promises'
import { platform, arch } from 'node:os'

import type { RecordId } from '@factory/contract'
import { canonicalJson } from '@factory/contract'

import { sealReviewerRawAttempt, type ReviewerRawAttempt } from './attempt'
import { readVerifiedReviewBundle, type ReviewerChoice, type VerifiedReviewBundle } from './bundle'
import { planReviewerIsolation, type ReadonlyAuthMount } from './index'
import { runIsolationProbe } from './probe'

export type ReviewerExecutionInput = {
  reviewId: RecordId
  imageDigest: string
  /** Git-common private runtime root selected by the coordinator. */
  runtimeRoot: string
  auth: readonly Omit<ReadonlyAuthMount, 'mode'>[]
  timeoutMs: number
  signal?: AbortSignal
  now?: () => Date
}

async function readResponsePrefix(
  path: string,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('review response is not an ordinary file')
      const length = Math.min(stat.size, 1024 * 1024)
      const bytes = new Uint8Array(length)
      let offset = 0
      while (offset < length) {
        const read = await handle.read(bytes, offset, length - offset, offset)
        if (read.bytesRead === 0) break
        offset += read.bytesRead
      }
      const after = await handle.stat()
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
        throw new Error('review response changed while it was read')
      }
      return { bytes: bytes.subarray(0, offset), truncated: stat.size > length }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { bytes: new Uint8Array(), truncated: false }
    throw error
  }
}

export interface ReviewerExecutor {
  run(
    bundle: VerifiedReviewBundle,
    choice: ReviewerChoice,
    input: ReviewerExecutionInput,
  ): Promise<ReviewerRawAttempt>
}

/** Production Docker execution through the same observed isolation boundary as the Slice 02 oracle. */
export const dockerReviewerExecutor: ReviewerExecutor = {
  async run(bundle, choice, input) {
    const before = await readVerifiedReviewBundle(bundle)
    if (canonicalJson(choice.settings) !== canonicalJson(before.manifest.plan.policies.reviewer)) {
      throw new TypeError('reviewer choice differs from the verified plan')
    }
    const outputHostPath = await mkdtemp(`${input.runtimeRoot}/review-output-`)
    await chmod(outputHostPath, 0o777)
    const plan = planReviewerIsolation({
      provider: choice.settings.provider,
      bundleHostPath: before.path,
      outputHostPath,
      auth: input.auth,
    })
    if (!plan.ok) throw new Error(`reviewer isolation refused: ${plan.reason}`)
    const now = input.now ?? (() => new Date())
    const startedAt = now().toISOString()
    try {
      const report = await runIsolationProbe(plan.plan, {
        imageDigest: input.imageDigest,
        expectedBundleSha256: before.sha256,
        reviewer: {
          model: choice.settings.model,
          effort: choice.settings.effort,
          promptVersion: before.manifest.plan.policies.promptVersion,
        },
        scenario: 'review',
        timeoutMs: input.timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      const response = await readResponsePrefix(`${outputHostPath}/response.txt`)
      await readVerifiedReviewBundle(bundle)
      return sealReviewerRawAttempt({
        reviewId: input.reviewId,
        response: response.bytes,
        termination:
          report.termination === 'timed-out'
            ? 'timed-out'
            : report.termination === 'cancelled'
              ? 'cancelled'
              : report.exitCode === 0
                ? 'completed'
                : 'crashed',
        exitCode: report.exitCode,
        outputTruncated: response.truncated,
        reviewer: choice,
        imageDigest: input.imageDigest,
        providerCliVersion: report.observation?.providerVersion ?? null,
        hostPlatform: `${platform()}/${arch()}`,
        startedAt,
        completedAt: now().toISOString(),
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await readVerifiedReviewBundle(bundle)
      return sealReviewerRawAttempt({
        reviewId: input.reviewId,
        response: new Uint8Array(),
        termination: 'docker-unavailable',
        exitCode: null,
        outputTruncated: false,
        reviewer: choice,
        imageDigest: input.imageDigest,
        providerCliVersion: null,
        hostPlatform: `${platform()}/${arch()}`,
        startedAt,
        completedAt: now().toISOString(),
      })
    } finally {
      await rm(outputHostPath, { recursive: true, force: true })
    }
  },
}
