import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { canonicalJson, newRecordId, type RecordId, type ReviewManifest } from '@factory/contract'
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
import { cleanupOwnedReviewerContainer } from './probe'

export type ReviewAttemptCoordinatorOptions =
  | {
      repositoryRoot: string
      testRuntimeRoot?: never
    }
  | {
      repositoryRoot?: never
      testRuntimeRoot: string
    }

type ReviewAttemptRunInput = Omit<
  ReviewerExecutionInput,
  'reviewId' | 'runtimeRoot' | 'containerIdentity'
> & {
  retryGeneration?: RecordId
}

type PersistedSnapshot = Omit<ReviewerRawAttemptSnapshot, 'submissions' | 'providerOutput'> & {
  submissionsBase64: string
  providerOutputBase64: string
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
      preparedPublication?: string
    }

function attemptKey(
  verified: Awaited<ReturnType<typeof readVerifiedReviewBundle>>,
  choice: ReviewerChoice,
  imageDigest: string,
  retryGeneration?: RecordId,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        bundleSha256: verified.sha256,
        reviewer: choice.settings,
        imageDigest,
        analyzerVersion: verified.manifest.plan.policies.analyzerVersion,
        promptVersion: verified.manifest.plan.policies.promptVersion,
        policyVersion: verified.manifest.plan.policies.policyVersion,
        formatVersion: verified.manifest.plan.policies.formatVersion,
        ...(retryGeneration === undefined ? {} : { retryGeneration }),
      }),
    )
    .digest('hex')
}

async function privateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isDirectory() || info.uid !== process.getuid?.())
      throw new Error('review runtime path is not an owned ordinary directory')
    await handle.chmod(0o700)
  } finally {
    await handle.close()
  }
}

async function attemptDirectoryExists(path: string): Promise<boolean> {
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return false
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error('review attempt root is not an ordinary directory')
  return true
}

async function cleanupStartedArtifacts(
  attemptRoot: string,
  containerIdentity: { name: string; label: string },
  timeoutMs: number,
): Promise<void> {
  await cleanupOwnedReviewerContainer(containerIdentity, timeoutMs)
  for (const entry of await readdir(attemptRoot, { withFileTypes: true })) {
    if (!/^review-(?:output|input|auth)-[A-Za-z0-9_-]+$/.test(entry.name)) continue
    const path = join(attemptRoot, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('review runtime contains an unsafe execution artifact')
    await rm(path, { recursive: true })
  }
}

async function cleanupStateTemps(attemptRoot: string): Promise<void> {
  for (const entry of await readdir(attemptRoot, { withFileTypes: true })) {
    if (
      !/^state\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(
        entry.name,
      )
    )
      continue
    const path = join(attemptRoot, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error('review runtime contains an unsafe state temporary')
    await unlink(path)
  }
}

async function atomicState(path: string, value: AttemptState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const bytes = Buffer.from(canonicalJson(value))
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error('review attempt state exceeds byte bound')
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

// Two bounded streams plus one prepared graph; the outer cap also bounds JSON string escaping.
const MAX_PUBLICATION_BYTES = 8 * 1024 * 1024
const MAX_STATE_BYTES = 20 * 1024 * 1024

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
    (Object.keys(state).length === 6 ||
      (Object.keys(state).length === 7 &&
        typeof state.preparedPublication === 'string' &&
        Buffer.byteLength(state.preparedPublication) <= MAX_PUBLICATION_BYTES)) &&
    attemptKeys.join(',') ===
      [
        'bundleSha256',
        'completedAt',
        'exitCode',
        'hostPlatform',
        'imageDigest',
        'outputTruncated',
        'providerCliVersion',
        'submissionsBase64',
        'providerOutputBase64',
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
  const { submissions, providerOutput, ...facts } = attempt
  return {
    ...facts,
    submissionsBase64: Buffer.from(submissions).toString('base64'),
    providerOutputBase64: Buffer.from(providerOutput).toString('base64'),
  }
}

function restored(attempt: PersistedSnapshot): ReviewerRawAttempt {
  const { submissionsBase64, providerOutputBase64, ...facts } = attempt
  const decode = (value: string) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      throw new Error('review attempt stream encoding is corrupt')
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') !== value || bytes.byteLength > 1024 * 1024)
      throw new Error('review attempt stream exceeds canonical byte bound')
    return bytes
  }
  return sealReviewerRawAttempt({
    ...facts,
    submissions: decode(submissionsBase64),
    providerOutput: decode(providerOutputBase64),
  })
}

export class ReviewAttemptCoordinator {
  private constructor(
    readonly runtimeRoot: string,
    private readonly lockRoot: string,
  ) {}

  static async open(options: ReviewAttemptCoordinatorOptions): Promise<ReviewAttemptCoordinator> {
    const authorityRoot =
      options.testRuntimeRoot ??
      (await locateGitCommonRuntime(await realpath(options.repositoryRoot!)))
    if (!isAbsolute(authorityRoot)) throw new TypeError('review runtime root must be absolute')
    await privateDirectory(authorityRoot)
    const root = join(await realpath(authorityRoot), 'review-attempts-v1')
    await privateDirectory(root)
    // Lock inodes outlive disposable attempts so queued owners never split locks.
    const lockRoot = join(await realpath(authorityRoot), 'review-attempt-locks')
    await privateDirectory(lockRoot)
    const coordinator = new ReviewAttemptCoordinator(root, lockRoot)
    await coordinator.recoverStartedAttempts()
    return coordinator
  }

  private async attemptRoots(): Promise<readonly { key: string; path: string }[]> {
    const roots: { key: string; path: string }[] = []
    let count = 0
    const directory = await opendir(this.runtimeRoot)
    try {
      for await (const entry of directory) {
        count += 1
        if (count > 10_000) throw new Error('review attempt inventory exceeds its bound')
        if (!/^[0-9a-f]{64}$/.test(entry.name)) continue
        const path = join(this.runtimeRoot, entry.name)
        if (!(await attemptDirectoryExists(path))) continue
        roots.push({ key: entry.name, path })
      }
    } finally {
      try {
        await directory.close()
      } catch {
        // Async iteration may already have closed the descriptor.
      }
    }
    return roots.sort((left, right) => left.key.localeCompare(right.key))
  }

  private async recoverStartedAttempts(): Promise<void> {
    for (const root of await this.attemptRoots()) {
      try {
        await withAdvisoryFileLock(join(this.lockRoot, root.key), 1, async () => {
          if (!(await attemptDirectoryExists(root.path))) return
          await cleanupStateTemps(root.path)
          const state = await readState(join(root.path, 'state.json'))
          if (state === undefined) return
          if (state.key !== root.key) throw new Error('review attempt root identity is corrupt')
          if (state.phase === 'started')
            await cleanupStartedArtifacts(root.path, state.containerIdentity, 30_000)
        })
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'advisory file lock is unavailable')
          throw error
      }
    }
  }

  async run(
    bundle: VerifiedReviewBundle,
    choice: ReviewerChoice,
    executor: ReviewerExecutor,
    input: ReviewAttemptRunInput,
  ): Promise<ReviewerRawAttempt> {
    const verified = await readVerifiedReviewBundle(bundle)
    const { retryGeneration, ...executionInput } = input
    const key = attemptKey(verified, choice, input.imageDigest, retryGeneration)
    const attemptRoot = join(this.runtimeRoot, key)
    const containerIdentity = {
      name: `factory-review-${key.slice(0, 20)}`,
      label: key,
    }
    const statePath = join(attemptRoot, 'state.json')
    return await withAdvisoryFileLock(join(this.lockRoot, key), 24 * 60 * 60 * 1_000, async () => {
      await privateDirectory(attemptRoot)
      await cleanupStateTemps(attemptRoot)
      const state = await readState(statePath)
      if (state !== undefined) {
        if (state.schemaVersion !== 1 || state.key !== key)
          throw new Error('review attempt state is corrupt')
        if (state.phase === 'completed') {
          const attempt = restored(state.attempt)
          const observed = readReviewerRawAttempt(attempt)
          if (
            observed.reviewId !== state.reviewId ||
            observed.bundleSha256 !== verified.sha256 ||
            canonicalJson(observed.reviewer.settings) !== canonicalJson(choice.settings) ||
            observed.imageDigest !== input.imageDigest
          )
            throw new Error('durable review attempt facts differ from their identity')
          return attempt
        }
        await cleanupStartedArtifacts(
          attemptRoot,
          state.containerIdentity,
          executionInput.timeoutMs,
        )
        return await this.executeStarted(
          state.reviewId,
          key,
          statePath,
          attemptRoot,
          bundle,
          choice,
          executor,
          executionInput,
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
      return await this.executeStarted(
        reviewId,
        key,
        statePath,
        attemptRoot,
        bundle,
        choice,
        executor,
        executionInput,
        containerIdentity,
      )
    })
  }

  /** Freeze acceptance bytes under the same ownership as the exact completed attempt. */
  async preparePublication(
    bundle: VerifiedReviewBundle,
    attempt: ReviewerRawAttempt,
    prepare: () => Promise<string>,
    retryGeneration?: RecordId,
  ): Promise<string> {
    const verified = await readVerifiedReviewBundle(bundle)
    const observed = readReviewerRawAttempt(attempt)
    const key = attemptKey(verified, observed.reviewer, observed.imageDigest, retryGeneration)
    const statePath = join(this.runtimeRoot, key, 'state.json')
    return await withAdvisoryFileLock(join(this.lockRoot, key), 24 * 60 * 60 * 1_000, async () => {
      const state = await readState(statePath)
      if (
        state?.phase !== 'completed' ||
        state.key !== key ||
        canonicalJson(state.attempt) !== canonicalJson(persisted(observed))
      )
        throw new Error('review publication differs from its durable attempt')
      if (state.preparedPublication !== undefined) return state.preparedPublication
      const preparedPublication = await prepare()
      if (Buffer.byteLength(preparedPublication) > MAX_PUBLICATION_BYTES)
        throw new Error('prepared review publication exceeds byte bound')
      if (canonicalJson(JSON.parse(preparedPublication)) !== preparedPublication)
        throw new Error('prepared review publication is not canonical')
      await atomicState(statePath, { ...state, preparedPublication })
      return preparedPublication
    })
  }

  /** Delete transient attempt state only after its immutable review publication succeeds. */
  async finalize(
    bundle: VerifiedReviewBundle,
    choice: ReviewerChoice,
    imageDigest: string,
    accepted: { reviewId: RecordId },
    retryGeneration?: RecordId,
  ): Promise<void> {
    const key = attemptKey(
      await readVerifiedReviewBundle(bundle),
      choice,
      imageDigest,
      retryGeneration,
    )
    const attemptRoot = join(this.runtimeRoot, key)
    const statePath = join(attemptRoot, 'state.json')
    await withAdvisoryFileLock(join(this.lockRoot, key), 24 * 60 * 60 * 1_000, async () => {
      if (!(await attemptDirectoryExists(attemptRoot))) return
      await cleanupStateTemps(attemptRoot)
      const state = await readState(statePath)
      if (state === undefined) throw new Error('review attempt finalization state is absent')
      if (state.key !== key || state.reviewId !== accepted.reviewId)
        throw new Error('review attempt finalization identity differs from durable state')
      if (state.phase !== 'completed')
        throw new Error('review attempt is not complete enough to finalize')
      await rm(attemptRoot, { recursive: true })
    })
  }

  /** Reconcile acceptance that committed before a process died during finalization. */
  async reconcileAccepted(reviews: readonly ReviewManifest[]): Promise<void> {
    for (const root of await this.attemptRoots()) {
      const attemptRoot = root.path
      const statePath = join(attemptRoot, 'state.json')
      let state = await readState(statePath)
      if (state === undefined || state.phase === 'started') continue
      const observed = readReviewerRawAttempt(restored(state.attempt))
      const review = reviews.find(
        candidate =>
          observed.reviewId === candidate.reviewId &&
          observed.bundleSha256 === candidate.bundleSha256 &&
          canonicalJson(observed.reviewer.settings) === canonicalJson(candidate.reviewer) &&
          observed.imageDigest === candidate.containerImageDigest,
      )
      if (review === undefined) continue
      await withAdvisoryFileLock(join(this.lockRoot, root.key), 24 * 60 * 60 * 1_000, async () => {
        if (!(await attemptDirectoryExists(attemptRoot))) return
        await cleanupStateTemps(attemptRoot)
        state = await readState(statePath)
        if (state === undefined) return
        if (state.phase !== 'completed' || state.reviewId !== review.reviewId)
          throw new Error('review attempt changed during acceptance reconciliation')
        const current = readReviewerRawAttempt(restored(state.attempt))
        if (
          current.bundleSha256 !== review.bundleSha256 ||
          canonicalJson(current.reviewer.settings) !== canonicalJson(review.reviewer) ||
          current.imageDigest !== review.containerImageDigest
        )
          throw new Error('review attempt changed during acceptance reconciliation')
        await rm(attemptRoot, { recursive: true })
      })
    }
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
    return attempt
  }
}
