import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { canonicalJson, newRecordId, type RecordId } from '@factory/contract'
import { withAdvisoryFileLock } from '@factory/repository'
import { locateGitCommonRuntime } from '@factory/runtime-journal'

import {
  readReviewerRawAttempt,
  sealReviewerRawAttempt,
  type ReviewerRawAttempt,
  type ReviewerRawAttemptSnapshot,
} from './attempt'
import { readVerifiedReviewBundle, type ReviewerChoice, type VerifiedReviewBundle } from './bundle'
import type { ReviewerExecutionInput, ReviewerExecutor } from './execution'

export type ReviewAttemptBoundary = 'identity-persisted' | 'attempt-persisted'

export type ReviewAttemptCoordinatorOptions =
  | {
      repositoryRoot: string
      testRuntimeRoot?: never
      onBoundary?: (boundary: ReviewAttemptBoundary) => void | Promise<void>
    }
  | {
      repositoryRoot?: never
      testRuntimeRoot: string
      onBoundary?: (boundary: ReviewAttemptBoundary) => void | Promise<void>
    }

type PersistedSnapshot = Omit<ReviewerRawAttemptSnapshot, 'response'> & {
  responseBase64: string
}

type AttemptState =
  | {
      schemaVersion: 1
      key: string
      reviewId: RecordId
      phase: 'started'
      containerIdentity: { name: string; label: string }
    }
  | {
      schemaVersion: 1
      key: string
      reviewId: RecordId
      phase: 'completed'
      containerIdentity: { name: string; label: string }
      attempt: PersistedSnapshot
    }

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function atomicState(path: string, value: AttemptState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const bytes = Buffer.from(canonicalJson(value))
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, 0o600)
    const directory = await open(join(path, '..'), constants.O_RDONLY)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

const MAX_STATE_BYTES = 2 * 1024 * 1024

async function readState(path: string): Promise<AttemptState | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_STATE_BYTES)
      throw new Error('review attempt state is not a bounded ordinary file')
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const after = await handle.stat()
    if (
      offset !== bytes.byteLength ||
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== info.size
    )
      throw new Error('review attempt state changed while it was read')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const state = JSON.parse(text) as AttemptState
    if (canonicalJson(state) !== text || !isAttemptState(state))
      throw new Error('review attempt state is not canonical')
    return state
  } finally {
    await handle.close()
  }
}

function isAttemptState(value: unknown): value is AttemptState {
  if (value === null || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  const identity = state.containerIdentity as Record<string, unknown> | undefined
  if (
    state.schemaVersion !== 1 ||
    typeof state.key !== 'string' ||
    !/^[0-9a-f]{64}$/.test(state.key) ||
    typeof state.reviewId !== 'string' ||
    !state.reviewId.startsWith('review_') ||
    identity === undefined ||
    typeof identity.name !== 'string' ||
    !/^factory-review-[0-9a-f]{20}$/.test(identity.name) ||
    typeof identity.label !== 'string' ||
    identity.label !== state.key ||
    Object.keys(identity).sort().join(',') !== 'label,name'
  )
    return false
  if (state.phase === 'started') return Object.keys(state).length === 5
  if (state.phase !== 'completed' || state.attempt === null || typeof state.attempt !== 'object')
    return false
  const attemptKeys = Object.keys(state.attempt as Record<string, unknown>).sort()
  return (
    Object.keys(state).length === 6 &&
    attemptKeys.join(',') ===
      [
        'bundleSha256',
        'completedAt',
        'exitCode',
        'hostPlatform',
        'imageDigest',
        'outputTruncated',
        'providerCliVersion',
        'responseBase64',
        'reviewId',
        'reviewer',
        'startedAt',
        'termination',
      ]
        .sort()
        .join(',')
  )
}

function persisted(attempt: ReviewerRawAttemptSnapshot): PersistedSnapshot {
  const { response, ...facts } = attempt
  return { ...facts, responseBase64: Buffer.from(response).toString('base64') }
}

function restored(attempt: PersistedSnapshot): ReviewerRawAttempt {
  const { responseBase64, ...facts } = attempt
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(responseBase64))
    throw new Error('review attempt response encoding is corrupt')
  const response = Buffer.from(responseBase64, 'base64')
  if (response.toString('base64') !== responseBase64)
    throw new Error('review attempt response encoding is not canonical')
  if (response.byteLength > 1024 * 1024)
    throw new Error('review attempt state exceeds response bound')
  return sealReviewerRawAttempt({ ...facts, response })
}

export class ReviewAttemptCoordinator {
  private constructor(
    readonly runtimeRoot: string,
    private readonly onBoundary?: ReviewAttemptCoordinatorOptions['onBoundary'],
  ) {}

  static async open(options: ReviewAttemptCoordinatorOptions): Promise<ReviewAttemptCoordinator> {
    const authorityRoot =
      options.testRuntimeRoot ??
      (await locateGitCommonRuntime(await realpath(options.repositoryRoot!)))
    if (!isAbsolute(authorityRoot)) throw new TypeError('review runtime root must be absolute')
    await privateDirectory(authorityRoot)
    const root = join(await realpath(authorityRoot), 'review-attempts-v1')
    await privateDirectory(root)
    return new ReviewAttemptCoordinator(root, options.onBoundary)
  }

  async run(
    bundle: VerifiedReviewBundle,
    choice: ReviewerChoice,
    executor: ReviewerExecutor,
    input: Omit<ReviewerExecutionInput, 'reviewId' | 'runtimeRoot' | 'containerIdentity'>,
  ): Promise<ReviewerRawAttempt> {
    const verified = await readVerifiedReviewBundle(bundle)
    const identity = {
      bundleSha256: verified.sha256,
      reviewer: choice.settings,
      imageDigest: input.imageDigest,
      analyzerVersion: verified.manifest.plan.policies.analyzerVersion,
      promptVersion: verified.manifest.plan.policies.promptVersion,
      policyVersion: verified.manifest.plan.policies.policyVersion,
      formatVersion: verified.manifest.plan.policies.formatVersion,
    }
    const key = createHash('sha256').update(canonicalJson(identity)).digest('hex')
    const attemptRoot = join(this.runtimeRoot, key)
    const containerIdentity = {
      name: `factory-review-${key.slice(0, 20)}`,
      label: key,
    }
    await privateDirectory(attemptRoot)
    const statePath = join(attemptRoot, 'state.json')
    return await withAdvisoryFileLock(
      join(attemptRoot, 'attempt.lock'),
      24 * 60 * 60 * 1_000,
      async () => {
        const state = await readState(statePath)
        if (state !== undefined) {
          if (state.schemaVersion !== 1 || state.key !== key)
            throw new Error('review attempt state is corrupt')
          if (state.phase === 'completed') return restored(state.attempt)
          return await this.executeStarted(
            state.reviewId,
            key,
            statePath,
            attemptRoot,
            bundle,
            choice,
            executor,
            input,
            state.containerIdentity,
          )
        }
        const reviewId = newRecordId('review')
        await atomicState(statePath, {
          schemaVersion: 1,
          key,
          reviewId,
          phase: 'started',
          containerIdentity,
        })
        await this.onBoundary?.('identity-persisted')
        return await this.executeStarted(
          reviewId,
          key,
          statePath,
          attemptRoot,
          bundle,
          choice,
          executor,
          input,
          containerIdentity,
        )
      },
    )
  }

  private async executeStarted(
    reviewId: RecordId,
    key: string,
    statePath: string,
    attemptRoot: string,
    bundle: VerifiedReviewBundle,
    choice: ReviewerChoice,
    executor: ReviewerExecutor,
    input: Omit<ReviewerExecutionInput, 'reviewId' | 'runtimeRoot' | 'containerIdentity'>,
    containerIdentity: { name: string; label: string },
  ): Promise<ReviewerRawAttempt> {
    const attempt = await executor.run(bundle, choice, {
      ...input,
      reviewId,
      runtimeRoot: attemptRoot,
      containerIdentity,
    })
    const observed = readReviewerRawAttempt(attempt)
    const verified = await readVerifiedReviewBundle(bundle)
    if (
      observed.reviewId !== reviewId ||
      observed.bundleSha256 !== verified.sha256 ||
      canonicalJson(observed.reviewer.settings) !== canonicalJson(choice.settings) ||
      observed.imageDigest !== input.imageDigest
    )
      throw new Error('review executor returned facts outside its durable attempt identity')
    await atomicState(statePath, {
      schemaVersion: 1,
      key,
      reviewId,
      phase: 'completed',
      containerIdentity,
      attempt: persisted(observed),
    })
    await this.onBoundary?.('attempt-persisted')
    return attempt
  }
}
