import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { platform, arch } from 'node:os'
import { dirname, join } from 'node:path'

import type { DockerLimits, RecordId } from '@factory/contract'
import { canonicalJson } from '@factory/contract'

import { reviewerAdapter } from './adapter'
import { sealReviewerRawAttempt, type ReviewerRawAttempt } from './attempt'
import { materializeReviewerCredential, type ReviewerCredentialSource } from './authentication'
import {
  openVerifiedReviewBundle,
  readVerifiedReviewBundle,
  type ReviewerChoice,
  type VerifiedReviewBundle,
} from './bundle'
import { planReviewerIsolation } from './isolation'
import {
  ReviewerCleanupUnprovenError,
  ReviewerDockerUnavailableError,
  ReviewerSetupInterruptedError,
} from './probe'
import { runReviewerContainer } from './runner'

export type ReviewerExecutionInput = {
  reviewId: RecordId
  /** Immutable Docker reference used for acquisition and execution. */
  imageReference: string
  imageDigest: string
  /** Git-common private runtime root selected by the coordinator. */
  runtimeRoot: string
  credential?: ReviewerCredentialSource
  timeoutMs: number
  dockerLimits?: Partial<DockerLimits>
  signal?: AbortSignal
  now?: () => Date
  containerIdentity: { name: string; label: string }
}

async function readSubmissionPrefix(
  path: string,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('review submissions is not an ordinary file')
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
        throw new Error('review submissions changed while it was read')
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

export function reviewerExecutionFailureTermination(
  error: unknown,
): 'docker-unavailable' | 'crashed' | 'timed-out' | 'cancelled' {
  if (error instanceof ReviewerSetupInterruptedError) return error.termination
  return error instanceof ReviewerDockerUnavailableError ||
    (error as NodeJS.ErrnoException).code === 'ENOENT'
    ? 'docker-unavailable'
    : 'crashed'
}

async function immutableBundleSnapshot(
  bundle: VerifiedReviewBundle,
  runtimeRoot: string,
): Promise<{ bundle: VerifiedReviewBundle; root: string }> {
  const verified = await readVerifiedReviewBundle(bundle)
  const root = await mkdtemp(join(runtimeRoot, 'review-input-'))
  await chmod(root, 0o755)
  try {
    for (const file of [{ path: 'bundle.json' }, ...verified.manifest.files]) {
      const target = join(root, file.path)
      await mkdir(dirname(target), { recursive: true, mode: 0o755 })
      await copyFile(join(verified.path, file.path), target, constants.COPYFILE_EXCL)
      await chmod(target, 0o444)
    }
    return { bundle: await openVerifiedReviewBundle(root, verified.sha256), root }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
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
        submissions: new Uint8Array(),
        providerOutput: new Uint8Array(),
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

/** Execute only after Docker's observed container state satisfies the isolation policy. */
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
    let snapshotRoot: string | undefined
    let credentialRoot: string | undefined
    try {
      outputHostPath = await mkdtemp(`${input.runtimeRoot}/review-output-`)
      await chmod(outputHostPath, 0o777)
      const snapshot = await immutableBundleSnapshot(bundle, input.runtimeRoot)
      snapshotRoot = snapshot.root
      const credential =
        input.credential === undefined
          ? undefined
          : await materializeReviewerCredential(input.credential, input.runtimeRoot)
      credentialRoot = credential?.root
      const plan = planReviewerIsolation({
        provider: choice.settings.provider,
        bundleHostPath: snapshot.root,
        outputHostPath,
        auth: credential === undefined ? [] : [credential.mount],
      })
      if (!plan.ok) throw new Error(`reviewer isolation refused: ${plan.reason}`)
      const report = await runReviewerContainer(plan.plan, {
        imageReference: input.imageReference,
        imageDigest: input.imageDigest,
        expectedBundleSha256: before.sha256,
        reviewer: {
          model: choice.settings.model,
          effort: choice.settings.effort,
          promptVersion: before.manifest.plan.policies.promptVersion,
        },
        invocation: reviewerAdapter(choice.settings),
        containerIdentity: input.containerIdentity,
        timeoutMs: remaining(),
        dockerLimits: input.dockerLimits,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      const response = await readSubmissionPrefix(`${outputHostPath}/submissions.jsonl`)
      const providerOutput = await readSubmissionPrefix(`${outputHostPath}/response.txt`)
      await readVerifiedReviewBundle(snapshot.bundle)
      await readVerifiedReviewBundle(bundle)
      return sealReviewerRawAttempt({
        reviewId: input.reviewId,
        bundleSha256: before.sha256,
        submissions: response.bytes,
        providerOutput: providerOutput.bytes,
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
        providerCliVersion: report.providerCliVersion,
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
        submissions: new Uint8Array(),
        providerOutput: new Uint8Array(),
        termination: reviewerExecutionFailureTermination(error),
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
      if (snapshotRoot !== undefined) await rm(snapshotRoot, { recursive: true, force: true })
      if (credentialRoot !== undefined) await rm(credentialRoot, { recursive: true, force: true })
    }
  },
}
