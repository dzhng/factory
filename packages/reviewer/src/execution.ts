import { constants } from 'node:fs'
import { chmod, mkdtemp, open, rm } from 'node:fs/promises'
import { platform, arch } from 'node:os'

import type { RecordId } from '@factory/contract'
import { canonicalJson } from '@factory/contract'

import { reviewerAdapter } from './adapter'
import { sealReviewerRawAttempt, type ReviewerRawAttempt } from './attempt'
import { readVerifiedReviewBundle, type ReviewerChoice, type VerifiedReviewBundle } from './bundle'
import { planReviewerIsolation, type ReadonlyAuthMount } from './index'
import { ReviewerCleanupUnprovenError, runIsolationProbe } from './probe'

export type ReviewerExecutionInput = {
  reviewId: RecordId
  imageDigest: string
  /** Git-common private runtime root selected by the coordinator. */
  runtimeRoot: string
  auth: readonly Omit<ReadonlyAuthMount, 'mode'>[]
  timeoutMs: number
  signal?: AbortSignal
  now?: () => Date
  containerIdentity: { name: string; label: string }
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

export function unavailableReviewerExecutor(): ReviewerExecutor {
  return {
    async run(bundle, choice, input) {
      const verified = await readVerifiedReviewBundle(bundle)
      const now = input.now ?? (() => new Date())
      const at = now().toISOString()
      return sealReviewerRawAttempt({
        reviewId: input.reviewId,
        bundleSha256: verified.sha256,
        response: new Uint8Array(),
        termination: 'authentication-unavailable',
        exitCode: null,
        outputTruncated: false,
        reviewer: choice,
        imageDigest: input.imageDigest,
        providerCliVersion: null,
        hostPlatform: `${platform()}/${arch()}`,
        startedAt: at,
        completedAt: at,
      })
    },
  }
}

/** Production Docker execution through the same observed isolation boundary as the Slice 02 oracle. */
export const dockerReviewerExecutor: ReviewerExecutor = {
  async run(bundle, choice, input) {
    const before = await readVerifiedReviewBundle(bundle)
    if (canonicalJson(choice.settings) !== canonicalJson(before.manifest.plan.policies.reviewer)) {
      throw new TypeError('reviewer choice differs from the verified plan')
    }
    const now = input.now ?? (() => new Date())
    const startedAt = now().toISOString()
    const deadline = Date.now() + input.timeoutMs
    const remaining = () => Math.max(1, deadline - Date.now())
    let outputHostPath: string | undefined
    try {
      outputHostPath = await mkdtemp(`${input.runtimeRoot}/review-output-`)
      await chmod(outputHostPath, 0o777)
      const plan = planReviewerIsolation({
        provider: choice.settings.provider,
        bundleHostPath: before.path,
        outputHostPath,
        auth: input.auth,
      })
      if (!plan.ok) throw new Error(`reviewer isolation refused: ${plan.reason}`)
      const report = await runIsolationProbe(plan.plan, {
        imageDigest: input.imageDigest,
        expectedBundleSha256: before.sha256,
        bundleBytes:
          Buffer.byteLength(canonicalJson(before.manifest)) +
          before.manifest.files.reduce((total, file) => total + file.bytes, 0),
        reviewer: {
          model: choice.settings.model,
          effort: choice.settings.effort,
          promptVersion: before.manifest.plan.policies.promptVersion,
        },
        invocation: reviewerAdapter(choice.settings),
        containerIdentity: input.containerIdentity,
        scenario: 'review',
        timeoutMs: remaining(),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      const response = await readResponsePrefix(`${outputHostPath}/response.txt`)
      await readVerifiedReviewBundle(bundle)
      return sealReviewerRawAttempt({
        reviewId: input.reviewId,
        bundleSha256: before.sha256,
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
      if (error instanceof ReviewerCleanupUnprovenError) throw error
      await readVerifiedReviewBundle(bundle)
      return sealReviewerRawAttempt({
        reviewId: input.reviewId,
        bundleSha256: before.sha256,
        response: new Uint8Array(),
        termination:
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'docker-unavailable' : 'crashed',
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
      if (outputHostPath !== undefined) await rm(outputHostPath, { recursive: true, force: true })
    }
  },
}
