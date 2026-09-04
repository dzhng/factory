import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { canonicalJson, newRecordId, type RecordId } from '@factory/contract'
import { withAdvisoryFileLock } from '@factory/repository'

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
  | { schemaVersion: 1; key: string; reviewId: RecordId; phase: 'started' }
  | {
      schemaVersion: 1
      key: string
      reviewId: RecordId
      phase: 'completed'
      attempt: PersistedSnapshot
    }

async function gitCommonDirectory(repositoryRoot: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += String(chunk)
      if (stdout.length > 32 * 1024) child.kill('SIGKILL')
    })
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += String(chunk)
      if (stderr.length > 32 * 1024) child.kill('SIGKILL')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error('Factory could not locate the Git common directory'))
      else resolve(stdout.trim())
    })
  })
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function atomicState(path: string, value: AttemptState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, canonicalJson(value), { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

function persisted(attempt: ReviewerRawAttemptSnapshot): PersistedSnapshot {
  const { response, ...facts } = attempt
  return { ...facts, responseBase64: Buffer.from(response).toString('base64') }
}

function restored(attempt: PersistedSnapshot): ReviewerRawAttempt {
  const { responseBase64, ...facts } = attempt
  const response = Buffer.from(responseBase64, 'base64')
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
      join(await gitCommonDirectory(await realpath(options.repositoryRoot!)), 'factory-runtime')
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
    input: Omit<ReviewerExecutionInput, 'reviewId' | 'runtimeRoot'>,
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
    await privateDirectory(attemptRoot)
    const statePath = join(attemptRoot, 'state.json')
    return await withAdvisoryFileLock(join(attemptRoot, 'attempt.lock'), 30_000, async () => {
      const prior = await readFile(statePath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (prior !== undefined) {
        if (Buffer.byteLength(prior) > 2 * 1024 * 1024)
          throw new Error('review attempt state exceeds byte bound')
        const state = JSON.parse(prior) as AttemptState
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
        )
      }
      const reviewId = newRecordId('review')
      await atomicState(statePath, { schemaVersion: 1, key, reviewId, phase: 'started' })
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
      )
    })
  }

  private async executeStarted(
    reviewId: RecordId,
    key: string,
    statePath: string,
    attemptRoot: string,
    bundle: VerifiedReviewBundle,
    choice: ReviewerChoice,
    executor: ReviewerExecutor,
    input: Omit<ReviewerExecutionInput, 'reviewId' | 'runtimeRoot'>,
  ): Promise<ReviewerRawAttempt> {
    const attempt = await executor.run(bundle, choice, {
      ...input,
      reviewId,
      runtimeRoot: attemptRoot,
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
      attempt: persisted(observed),
    })
    await this.onBoundary?.('attempt-persisted')
    return attempt
  }
}
