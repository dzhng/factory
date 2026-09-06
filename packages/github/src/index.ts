import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  canonicalJson,
  githubRepositoryKey,
  isGitBranchName,
  isGithubRepositoryLocator,
  makeOwnedPath,
  newRecordId,
  validatePublicRecord,
  validateObjectRef,
  type GithubRepositoryKey,
  type GithubRepositoryMappingObservation,
  type ObjectRef,
  type AvailablePullRequestObservation,
  type PullRequestObservation,
  type PullRequestUnavailableReason,
  type RecordId,
  type RepositoryId,
  type AssociationBatch,
  type SessionPullRequestAssociation,
} from '@factory/contract'
import {
  RepositoryStore,
  prepareGithubMetadata,
  type PublicationPreparation,
} from '@factory/repository'
import { SanitizationError } from '@factory/sanitization'

import { PreparedPrObjects, preparePatch, requireUnchanged, type Sanitizer } from './preparation'

export type PullRequestRef = {
  hostname: string
  owner: string
  name: string
  number: number
}

export type GhCommandResult =
  | {
      kind: 'completed'
      exitCode: number
      stdout: Uint8Array
      stderr: Uint8Array
    }
  | {
      kind: 'missing' | 'timeout' | 'output-limit'
      stdout: Uint8Array
      stderr: Uint8Array
    }

export interface GhCommandRunner {
  run(args: readonly string[], maximumDurationMs?: number): Promise<GhCommandResult>
}

export type GithubDefaultBranchObservation =
  | { availability: 'available'; branch: string }
  | {
      availability: 'unavailable'
      reason:
        | 'gh-missing'
        | 'authentication-required'
        | 'command-timeout'
        | 'output-limit'
        | 'command-failed'
        | 'malformed-response'
    }

export type GithubDefaultBranchOptions = {
  run?: GhCommandRunner['run']
  maximumBytes?: number
  maximumDurationMs?: number
  executable?: string
  cwd?: string
  environment?: NodeJS.ProcessEnv
}

export interface PrObjectStore {
  put(bytes: Uint8Array, metadata: { mediaType: string; role: string }): Promise<ObjectRef>
}

type DeadlineResult<T> = { kind: 'completed'; value: T } | { kind: 'failed' } | { kind: 'timeout' }

async function settleWithinDeadline<T>(
  start: () => Promise<T>,
  deadline: number,
): Promise<DeadlineResult<T>> {
  const remaining = deadline - performance.now()
  if (remaining <= 0) return { kind: 'timeout' }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ kind: 'timeout' }>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining)
  })
  const operation = Promise.resolve()
    .then(start)
    .then(value => ({ kind: 'completed' as const, value }))
    .catch(() => ({ kind: 'failed' as const }))
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export type GithubPrObserverOptions = {
  sanitizer: Sanitizer
  run?: GhCommandRunner['run']
  objects: PrObjectStore
  maxCommandBytes?: number
  maxCommandDurationMs?: number
  maxGhBytes?: number
  maxAcquisitionDurationMs?: number
  maxCodeCaptureDurationMs?: number
  maxCommits?: number
  maxCommitPages?: number
  /** Optional exact-SHA snapshot seam; requested failures remain explicit limitations. */
  captureCodeManifest?: (input: {
    sanitizer: Sanitizer
    objects: PrObjectStore
    pullRequest: {
      hostname: string
      number: number
      url: string
      base: {
        repositoryKey: GithubRepositoryKey
        externalId: string
        repository: string
        ref?: string
        sha?: string
      }
      head: {
        repositoryKey: GithubRepositoryKey
        externalId: string
        repository: string
        ref?: string
        sha: string
      }
    }
    signal: AbortSignal
    deadlineMs: number
  }) => Promise<ObjectRef | undefined>
  now?: () => Date
  /** Exact local repository whose authenticated gh context is being observed. */
  cwd?: string
  /** Environment of the invoking Factory command, including its selected gh executable path. */
  environment?: NodeJS.ProcessEnv
}

/** Runtime-only typed failure when no provider-stable repository identity can be proven. */
export type PrUnavailable = {
  availability: 'unavailable'
  reason: PullRequestUnavailableReason
  requested: PullRequestRef
  observedAt: string
  evidence: readonly ObjectRef[]
  detail: string
  /** Persistable only after GitHub returned its stable repository identity. */
  record?: Extract<PullRequestObservation, { availability: 'unavailable' }>
}

type Metadata = {
  repositoryId: string
  repository: string
  repositoryUrl: string
  externalId: string
  url: string
  number: number
  state: 'open' | 'closed' | 'merged'
  baseRef?: string
  baseSha?: string
  headRepositoryId?: string
  headRepository?: string
  headRef?: string
  headSha?: string
  updatedAt: string
  commits: string[]
  commitsComplete: boolean
  endCursor?: string
}

const QUERY = `query FactoryPullRequest($owner:String!,$name:String!,$number:Int!,$limit:Int!,$cursor:String){repository(owner:$owner,name:$name){id nameWithOwner url pullRequest(number:$number){id url number state mergedAt baseRefName baseRefOid headRefName headRefOid updatedAt headRepository{id nameWithOwner url} commits(first:$limit,after:$cursor){nodes{commit{oid}} pageInfo{hasNextPage endCursor}}}}}`

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function recordId(prefix: string, observedAt: string, identity: string): RecordId {
  return newRecordId(
    prefix,
    Date.parse(observedAt),
    Buffer.from(hash(identity).slice(0, 20), 'hex'),
  )
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096)
    throw new TypeError(`${label} is invalid`)
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new TypeError(`${label} is not a Git object ID`)
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined
  assertString(value, label)
  return value
}

function optionalSha(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined
  assertSha(value, label)
  return value
}

function isUtcTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value)
  const parsed = new Date(value)
  return (
    match !== null &&
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6])
  )
}

function parseMetadata(bytes: Uint8Array, requestedNumber: number, hostname: string): Metadata {
  if (!Number.isSafeInteger(requestedNumber) || requestedNumber <= 0)
    throw new TypeError('pull request number is invalid')
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value = JSON.parse(decoded) as Record<string, unknown>
  if ('errors' in value && (!Array.isArray(value.errors) || value.errors.length > 0)) {
    throw new TypeError('GraphQL response errors are invalid')
  }
  const data = value.data as Record<string, unknown> | undefined
  const repository = data?.repository as Record<string, unknown> | undefined
  const pullRequest = repository?.pullRequest as Record<string, unknown> | undefined
  if (repository === undefined || pullRequest === undefined)
    throw new TypeError('pull request is absent')
  assertString(repository.id, 'repository.id')
  assertString(repository.nameWithOwner, 'repository.nameWithOwner')
  assertString(repository.url, 'repository.url')
  assertString(pullRequest.id, 'pullRequest.id')
  assertString(pullRequest.url, 'pullRequest.url')
  for (const [label, providerUrl] of [
    ['repository.url', repository.url],
    ['pullRequest.url', pullRequest.url],
  ] as const) {
    let parsed: URL
    try {
      parsed = new URL(providerUrl)
    } catch {
      throw new TypeError(`${label} is invalid`)
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.toLowerCase() !== hostname.toLowerCase() ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new TypeError(`${label} is outside the requested GitHub host`)
    }
  }
  if (pullRequest.number !== requestedNumber)
    throw new TypeError('pull request number does not match')
  const baseRef = optionalString(pullRequest.baseRefName, 'pullRequest.baseRefName')
  const baseSha = optionalSha(pullRequest.baseRefOid, 'pullRequest.baseRefOid')
  const headRef = optionalString(pullRequest.headRefName, 'pullRequest.headRefName')
  const headSha = optionalSha(pullRequest.headRefOid, 'pullRequest.headRefOid')
  assertString(pullRequest.updatedAt, 'pullRequest.updatedAt')
  if (!isUtcTimestamp(pullRequest.updatedAt)) throw new TypeError('updatedAt is invalid')
  const headRepository =
    pullRequest.headRepository === null || pullRequest.headRepository === undefined
      ? undefined
      : (pullRequest.headRepository as Record<string, unknown>)
  if (headRepository !== undefined) {
    assertString(headRepository.id, 'pullRequest.headRepository.id')
    assertString(headRepository.nameWithOwner, 'pullRequest.headRepository.nameWithOwner')
    assertString(headRepository.url, 'pullRequest.headRepository.url')
  }
  const repositoryLocators: Array<readonly [string, string, string]> = [
    ['repository', repository.nameWithOwner, repository.url],
  ]
  if (headRepository !== undefined) {
    repositoryLocators.push([
      'pullRequest.headRepository',
      headRepository.nameWithOwner as string,
      headRepository.url as string,
    ])
  }
  for (const [label, repositoryName, repositoryUrl] of repositoryLocators) {
    if (!isGithubRepositoryLocator(repositoryName)) {
      throw new TypeError(`${label}.nameWithOwner is invalid`)
    }
    const parsed = new URL(repositoryUrl)
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.toLowerCase() !== hostname.toLowerCase() ||
      parsed.pathname.replace(/\/$/, '') !== `/${repositoryName}` ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new TypeError(`${label}.url does not match its repository locator`)
    }
  }
  const pullRequestUrl = new URL(pullRequest.url)
  if (
    pullRequestUrl.pathname.replace(/\/$/, '') !==
    `/${repository.nameWithOwner}/pull/${requestedNumber}`
  ) {
    throw new TypeError('pullRequest.url does not match its pull-request locator')
  }
  const connection = pullRequest.commits as Record<string, unknown> | undefined
  if (connection === undefined || !Array.isArray(connection.nodes)) {
    throw new TypeError('commit connection is invalid')
  }
  const commits = connection.nodes.map((node, index) => {
    const commit = (node as Record<string, unknown>)?.commit as Record<string, unknown> | undefined
    assertSha(commit?.oid, `commits[${index}].oid`)
    return commit.oid
  })
  if (new Set(commits).size !== commits.length)
    throw new TypeError('commit page contains duplicates')
  const pageInfo = connection.pageInfo as Record<string, unknown> | undefined
  if (pageInfo === undefined || typeof pageInfo.hasNextPage !== 'boolean') {
    throw new TypeError('commit page information is invalid')
  }
  if (
    pageInfo.hasNextPage &&
    (typeof pageInfo.endCursor !== 'string' || pageInfo.endCursor.length === 0)
  ) {
    throw new TypeError('commit page cursor is invalid')
  }
  let state: Metadata['state']
  if (pullRequest.mergedAt !== null && pullRequest.mergedAt !== undefined) {
    assertString(pullRequest.mergedAt, 'pullRequest.mergedAt')
    if (!isUtcTimestamp(pullRequest.mergedAt) || pullRequest.state !== 'MERGED') {
      throw new TypeError('pull request merged state is inconsistent')
    }
    state = 'merged'
  } else if (pullRequest.state === 'OPEN') state = 'open'
  else if (pullRequest.state === 'CLOSED') state = 'closed'
  else throw new TypeError('pull request state is invalid')
  return {
    repositoryId: repository.id,
    repository: repository.nameWithOwner,
    repositoryUrl: repository.url,
    externalId: pullRequest.id,
    url: pullRequest.url,
    number: requestedNumber,
    state,
    ...(baseRef === undefined ? {} : { baseRef }),
    ...(baseSha === undefined ? {} : { baseSha }),
    ...(headRepository === undefined
      ? {}
      : {
          headRepositoryId: headRepository.id as string,
          headRepository: headRepository.nameWithOwner as string,
        }),
    ...(headRef === undefined ? {} : { headRef }),
    ...(headSha === undefined ? {} : { headSha }),
    updatedAt: pullRequest.updatedAt,
    commits,
    commitsComplete: !pageInfo.hasNextPage,
    ...(typeof pageInfo.endCursor === 'string' ? { endCursor: pageInfo.endCursor } : {}),
  }
}

function sameSnapshot(left: Metadata, right: Metadata): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function unavailableReason(result: GhCommandResult): PullRequestUnavailableReason {
  if (result.kind === 'missing') return 'gh-missing'
  if (result.kind === 'timeout') return 'command-timeout'
  if (result.kind === 'output-limit') return 'output-limit'
  const message = new TextDecoder().decode(result.stderr).toLowerCase()
  if (message.includes('auth') || message.includes('login')) return 'authentication-required'
  if (message.includes('not found') || message.includes('could not resolve')) return 'not-found'
  return 'command-failed'
}

export async function runBoundedGh(
  args: readonly string[],
  maximumBytes: number,
  maximumDurationMs: number,
  executable = 'gh',
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Promise<GhCommandResult> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError('maximumBytes must be a positive integer')
  }
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1) {
    throw new TypeError('maximumDurationMs must be a positive integer')
  }
  return await new Promise(resolve => {
    const child = spawn(executable, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      ...(environment === undefined ? {} : { env: environment }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let terminalKind: 'timeout' | 'output-limit' | undefined
    let terminationTimer: NodeJS.Timeout | undefined
    let timer: NodeJS.Timeout | undefined
    const finish = (result: GhCommandResult) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (terminationTimer !== undefined) clearTimeout(terminationTimer)
      resolve(result)
    }
    const snapshot = () => ({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    })
    const terminate = (kind: 'timeout' | 'output-limit') => {
      if (terminalKind !== undefined || settled) return
      terminalKind = kind
      child.stdout.destroy()
      child.stderr.destroy()
      child.kill('SIGKILL')
      terminationTimer = setTimeout(() => finish({ kind, ...snapshot() }), 1_000)
    }
    const append = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (terminalKind !== undefined || settled) return
      const used = stdoutBytes + stderrBytes
      const retained = chunk.subarray(0, Math.max(0, maximumBytes - used))
      if (retained.byteLength > 0) target.push(retained)
      if (stream === 'stdout') stdoutBytes += retained.byteLength
      else stderrBytes += retained.byteLength
      if (retained.byteLength < chunk.byteLength) terminate('output-limit')
    }
    child.stdout.on('data', chunk => append(stdout, Buffer.from(chunk), 'stdout'))
    child.stderr.on('data', chunk => append(stderr, Buffer.from(chunk), 'stderr'))
    child.on('error', error => {
      finish({
        kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'completed',
        exitCode: 127,
        ...snapshot(),
      } as GhCommandResult)
    })
    child.on('close', code =>
      finish(
        terminalKind === undefined
          ? { kind: 'completed', exitCode: code ?? 1, ...snapshot() }
          : { kind: terminalKind, ...snapshot() },
      ),
    )
    timer = setTimeout(() => {
      terminate('timeout')
    }, maximumDurationMs)
  })
}

/** Observe GitHub's current default branch without making it durable configuration. */
export async function observeGithubDefaultBranch(
  options: GithubDefaultBranchOptions = {},
): Promise<GithubDefaultBranchObservation> {
  const maximumBytes = options.maximumBytes ?? 4_096
  const maximumDurationMs = options.maximumDurationMs ?? 10_000
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new TypeError('maximumBytes must be a positive integer')
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1)
    throw new TypeError('maximumDurationMs must be a positive integer')
  const run =
    options.run ??
    ((args: readonly string[], duration?: number) =>
      runBoundedGh(
        args,
        maximumBytes,
        duration ?? maximumDurationMs,
        options.executable,
        options.cwd,
        options.environment,
      ))
  const result = await run(
    ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
    maximumDurationMs,
  )
  if (result.kind !== 'completed') {
    const reason = {
      missing: 'gh-missing',
      timeout: 'command-timeout',
      'output-limit': 'output-limit',
    }[result.kind] as 'gh-missing' | 'command-timeout' | 'output-limit'
    return { availability: 'unavailable', reason }
  }
  if (result.exitCode !== 0) {
    const message = new TextDecoder().decode(result.stderr).toLowerCase()
    return {
      availability: 'unavailable',
      reason:
        message.includes('auth') || message.includes('login')
          ? 'authentication-required'
          : 'command-failed',
    }
  }
  try {
    const output = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)
    const branch = output.endsWith('\r\n')
      ? output.slice(0, -2)
      : output.endsWith('\n')
        ? output.slice(0, -1)
        : output
    if (!isGitBranchName(branch)) {
      return { availability: 'unavailable', reason: 'malformed-response' }
    }
    return { availability: 'available', branch }
  } catch {
    return { availability: 'unavailable', reason: 'malformed-response' }
  }
}

export class GithubPrObserver {
  private readonly run: GhCommandRunner['run']
  private readonly now: () => Date
  private readonly maxCommits: number
  private readonly maxCommitPages: number
  private readonly maxCommandDurationMs: number
  private readonly maxGhBytes: number
  private readonly maxAcquisitionDurationMs: number
  private readonly maxCodeCaptureDurationMs: number

  constructor(private readonly options: GithubPrObserverOptions) {
    const maximumBytes = options.maxCommandBytes ?? 16 * 1024 * 1024
    const maximumDurationMs = options.maxCommandDurationMs ?? 30_000
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new TypeError('maxCommandBytes must be a positive integer')
    }
    if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1) {
      throw new TypeError('maxCommandDurationMs must be a positive integer')
    }
    this.run =
      options.run ??
      ((args, duration) =>
        runBoundedGh(
          args,
          maximumBytes,
          Math.min(maximumDurationMs, duration ?? maximumDurationMs),
          'gh',
          options.cwd,
          options.environment,
        ))
    this.now = options.now ?? (() => new Date())
    this.maxCommits = options.maxCommits ?? 250
    this.maxCommitPages = options.maxCommitPages ?? Math.ceil(this.maxCommits / 100)
    this.maxCommandDurationMs = maximumDurationMs
    this.maxGhBytes = options.maxGhBytes ?? 64 * 1024 * 1024
    this.maxAcquisitionDurationMs = options.maxAcquisitionDurationMs ?? 120_000
    this.maxCodeCaptureDurationMs = options.maxCodeCaptureDurationMs ?? 30_000
    if (!Number.isSafeInteger(this.maxCommits) || this.maxCommits < 1) {
      throw new TypeError('maxCommits must be a positive integer')
    }
    if (!Number.isSafeInteger(this.maxCommitPages) || this.maxCommitPages < 1) {
      throw new TypeError('maxCommitPages must be a positive integer')
    }
    for (const [label, value] of [
      ['maxGhBytes', this.maxGhBytes],
      ['maxAcquisitionDurationMs', this.maxAcquisitionDurationMs],
      ['maxCodeCaptureDurationMs', this.maxCodeCaptureDurationMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError(`${label} must be a positive integer`)
    }
  }

  async observe(ref: PullRequestRef): Promise<AvailablePullRequestObservation | PrUnavailable> {
    const prepared = new PreparedPrObjects(this.maxGhBytes)
    const deadline = performance.now() + this.maxAcquisitionDurationMs
    try {
      const observation = await this.prepare(ref, prepared, deadline)
      const result = await settleWithinDeadline(
        () => prepared.publish(this.options.objects, deadline),
        deadline,
      )
      if (result.kind !== 'completed')
        return {
          availability: 'unavailable',
          reason: result.kind === 'timeout' ? 'command-timeout' : 'command-failed',
          requested: ref,
          observedAt: observation.observedAt,
          evidence: [],
          detail: 'Prepared GitHub evidence could not be published',
        }
      return observation
    } finally {
      prepared.close()
    }
  }

  private async prepare(
    ref: PullRequestRef,
    prepared: PreparedPrObjects,
    deadline: number,
  ): Promise<AvailablePullRequestObservation | PrUnavailable> {
    requireUnchanged(this.options.sanitizer, [ref.hostname, ref.owner, ref.name])
    if (!Number.isSafeInteger(ref.number) || ref.number < 1)
      throw new TypeError('PR number is invalid')
    githubRepositoryKey(ref.hostname, 'validate')
    for (const [label, value] of [
      ['owner', ref.owner],
      ['repository name', ref.name],
    ] as const) {
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(value)) throw new TypeError(`GitHub ${label} is invalid`)
    }
    const observedAt = this.now().toISOString()
    const evidence: ObjectRef[] = []
    const startedAt = performance.now()
    let ghBytes = 0
    const putBounded = async (
      bytes: Uint8Array,
      metadata: { mediaType: string; role: string },
    ): Promise<{ kind: 'stored'; object: ObjectRef } | { kind: 'timeout' }> => {
      const safe =
        metadata.mediaType === 'application/json'
          ? prepareGithubMetadata(bytes, this.options.sanitizer, prepared.transformation, true)
          : preparePatch(bytes, this.options.sanitizer, prepared.transformation)
      if (performance.now() >= deadline) return { kind: 'timeout' }
      return { kind: 'stored', object: await prepared.put(safe, metadata) }
    }
    const execute = async (args: readonly string[]): Promise<GhCommandResult> => {
      const remaining = this.maxAcquisitionDurationMs - (performance.now() - startedAt)
      if (remaining <= 0)
        return {
          kind: 'timeout',
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        }
      const execution = await settleWithinDeadline(
        () =>
          this.run(args, Math.min(this.maxCommandDurationMs, Math.max(1, Math.floor(remaining)))),
        deadline,
      )
      if (execution.kind === 'timeout') {
        return {
          kind: 'timeout',
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        }
      }
      if (execution.kind === 'failed') {
        return {
          kind: 'completed',
          exitCode: 1,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        }
      }
      const result = execution.value
      ghBytes += result.stdout.byteLength + result.stderr.byteLength
      if (ghBytes > this.maxGhBytes) {
        return {
          kind: 'output-limit',
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        }
      }
      return result
    }
    let repositoryKey: GithubRepositoryKey | undefined
    let baseIdentity: { externalId: string; repository: string } | undefined
    const unavailable = (reason: PullRequestUnavailableReason, detail: string): PrUnavailable => {
      let record: Extract<PullRequestObservation, { availability: 'unavailable' }> | undefined
      if (repositoryKey !== undefined && baseIdentity !== undefined && evidence.length > 0) {
        record = {
          schemaVersion: 1,
          observationId: recordId(
            'pr-observation',
            observedAt,
            `${repositoryKey}\0${ref.number}\0${reason}\0${evidence.map(item => item.sha256).join()}`,
          ),
          provider: 'github',
          repositoryKey,
          number: ref.number,
          availability: 'unavailable',
          reason,
          hostname: ref.hostname.toLowerCase(),
          base: {
            repositoryKey,
            externalId: baseIdentity.externalId,
            repository: baseIdentity.repository,
          },
          observedAt,
          evidence: evidence as [ObjectRef, ...ObjectRef[]],
          transformation: prepared.transformation,
          limitations: [{ code: 'unavailable-pull-request', detail }],
        }
        validatePublicRecord(
          makeOwnedPath('pull-requests', [
            'github',
            repositoryKey,
            String(ref.number),
            'observations',
            `${record.observationId}.json`,
          ]),
          record,
        )
      }
      return {
        availability: 'unavailable',
        reason,
        requested: ref,
        observedAt,
        evidence,
        detail,
        ...(record === undefined ? {} : { record }),
      }
    }
    const readSnapshot = async (): Promise<
      | { kind: 'observed'; metadata: Metadata }
      | {
          kind: 'unavailable'
          reason: ReturnType<typeof unavailableReason> | 'invalid-response' | 'observation-changed'
          detail: string
        }
    > => {
      const commits: string[] = []
      const seenCommits = new Set<string>()
      const seenCursors = new Set<string>()
      let cursor: string | undefined
      let firstPage: Metadata | undefined
      let pages = 0
      const finish = (complete: boolean, terminalCursor?: string): Metadata => {
        if (firstPage === undefined) throw new Error('pull-request metadata page is absent')
        const { endCursor: _initialCursor, ...facts } = firstPage
        return {
          ...facts,
          commits,
          commitsComplete: complete,
          ...(complete || terminalCursor === undefined ? {} : { endCursor: terminalCursor }),
        }
      }
      while (true) {
        const remaining = this.maxCommits - commits.length
        if (remaining === 0) {
          return { kind: 'observed', metadata: finish(false, cursor) }
        }
        const args = [
          'api',
          `--hostname=${ref.hostname}`,
          'graphql',
          '-f',
          `query=${QUERY}`,
          '-F',
          `owner=${ref.owner}`,
          '-F',
          `name=${ref.name}`,
          '-F',
          `number=${ref.number}`,
          '-F',
          `limit=${Math.min(100, remaining)}`,
          ...(cursor === undefined ? [] : ['-F', `cursor=${cursor}`]),
        ]
        const result = await execute(args)
        pages += 1
        if (result.kind !== 'completed' || result.exitCode !== 0) {
          return {
            kind: 'unavailable',
            reason: unavailableReason(result),
            detail: 'GitHub metadata was unavailable',
          }
        }
        let page: Metadata
        try {
          page = parseMetadata(result.stdout, ref.number, ref.hostname)
        } catch {
          return {
            kind: 'unavailable',
            reason: 'invalid-response',
            detail: 'GitHub returned malformed pull-request metadata',
          }
        }
        requireUnchanged(this.options.sanitizer, [
          page.repositoryId,
          page.repository,
          page.repositoryUrl,
          page.externalId,
          page.url,
          page.baseRef,
          page.headRepositoryId,
          page.headRepository,
          page.headRef,
        ])
        const metadataObject = await putBounded(result.stdout, {
          mediaType: 'application/json',
          role: 'github-pr-metadata',
        })
        if (metadataObject.kind !== 'stored') {
          return {
            kind: 'unavailable',
            reason: 'command-timeout',
            detail: 'GitHub metadata evidence could not be stored within the acquisition bound',
          }
        }
        evidence.push(metadataObject.object)
        const pageRepositoryKey = githubRepositoryKey(ref.hostname, page.repositoryId)
        if (repositoryKey === undefined) {
          repositoryKey = pageRepositoryKey
          baseIdentity = { externalId: page.repositoryId, repository: page.repository }
        } else if (repositoryKey !== pageRepositoryKey) {
          return {
            kind: 'unavailable',
            reason: 'observation-changed',
            detail: 'Pull request base repository identity changed during observation',
          }
        }
        if (firstPage === undefined) firstPage = page
        else {
          const pageFacts = {
            ...page,
            commits: firstPage.commits,
            commitsComplete: firstPage.commitsComplete,
            endCursor: firstPage.endCursor,
          }
          if (!sameSnapshot(firstPage, pageFacts)) {
            return {
              kind: 'unavailable',
              reason: 'observation-changed',
              detail: 'Pull request changed between commit pages',
            }
          }
        }
        if (page.commits.length > remaining) {
          return {
            kind: 'unavailable',
            reason: 'invalid-response',
            detail: 'GitHub returned more commits than Factory requested',
          }
        }
        commits.push(...page.commits)
        if (page.commits.some(sha => seenCommits.has(sha))) {
          return {
            kind: 'unavailable',
            reason: 'invalid-response',
            detail: 'GitHub repeated a commit between pages',
          }
        }
        page.commits.forEach(sha => seenCommits.add(sha))
        if (page.commitsComplete) {
          if (
            commits.length === 0 ||
            (page.headSha !== undefined && !commits.includes(page.headSha))
          ) {
            return {
              kind: 'unavailable',
              reason: 'invalid-response',
              detail: 'GitHub complete commit data does not contain the PR head',
            }
          }
          return { kind: 'observed', metadata: finish(true) }
        }
        if (commits.length >= this.maxCommits) {
          return { kind: 'observed', metadata: finish(false, page.endCursor) }
        }
        if (
          page.commits.length === 0 ||
          page.endCursor === undefined ||
          seenCursors.has(page.endCursor)
        ) {
          return {
            kind: 'unavailable',
            reason: 'invalid-response',
            detail: 'GitHub commit pagination made no progress',
          }
        }
        seenCursors.add(page.endCursor)
        if (pages >= this.maxCommitPages) {
          return { kind: 'observed', metadata: finish(false, page.endCursor) }
        }
        cursor = page.endCursor
      }
    }
    const firstRead = await readSnapshot()
    if (firstRead.kind === 'unavailable') return unavailable(firstRead.reason, firstRead.detail)
    const first = firstRead.metadata
    const diffResult = await execute([
      'pr',
      'diff',
      String(ref.number),
      '--repo',
      `${ref.hostname}/${ref.owner}/${ref.name}`,
      '--patch',
    ])
    if (diffResult.kind !== 'completed' || diffResult.exitCode !== 0) {
      return unavailable(unavailableReason(diffResult), 'GitHub pull-request diff was unavailable')
    }
    const diffStored = await putBounded(diffResult.stdout, {
      mediaType: 'text/x-diff',
      role: 'pull-request-diff',
    })
    if (diffStored.kind !== 'stored') {
      return unavailable(
        'command-timeout',
        'GitHub pull-request diff evidence could not be stored within the acquisition bound',
      )
    }
    const diff = diffStored.object
    evidence.push(diff)
    const secondRead = await readSnapshot()
    if (secondRead.kind === 'unavailable') return unavailable(secondRead.reason, secondRead.detail)
    const second = secondRead.metadata
    if (!sameSnapshot(first, second)) {
      return unavailable('observation-changed', 'Pull request changed while Factory observed it')
    }
    const baseRepositoryKey = githubRepositoryKey(ref.hostname, first.repositoryId)
    const headRepositoryKey =
      first.headRepositoryId === undefined
        ? undefined
        : githubRepositoryKey(ref.hostname, first.headRepositoryId)
    let codeManifest: ObjectRef | undefined
    if (headRepositoryKey !== undefined && first.headSha !== undefined) {
      const remaining = Math.max(
        0,
        Math.min(
          this.maxCodeCaptureDurationMs,
          this.maxAcquisitionDurationMs - (performance.now() - startedAt),
        ),
      )
      const controller = new AbortController()
      let captureTimer: NodeJS.Timeout | undefined
      try {
        if (remaining > 0 && this.options.captureCodeManifest !== undefined) {
          const timeout = new Promise<undefined>(resolve => {
            captureTimer = setTimeout(() => {
              controller.abort()
              resolve(undefined)
            }, remaining)
          })
          codeManifest = await Promise.race([
            this.options.captureCodeManifest({
              sanitizer: this.options.sanitizer,
              objects: {
                put: (bytes, metadata) => {
                  if (controller.signal.aborted) throw new Error('PR code acquisition ended')
                  return prepared.put(bytes, metadata)
                },
              },
              pullRequest: {
                hostname: ref.hostname.toLowerCase(),
                number: ref.number,
                url: first.url,
                base: {
                  repositoryKey: baseRepositoryKey,
                  externalId: first.repositoryId,
                  repository: first.repository,
                  ...(first.baseRef === undefined ? {} : { ref: first.baseRef }),
                  ...(first.baseSha === undefined ? {} : { sha: first.baseSha }),
                },
                head: {
                  repositoryKey: headRepositoryKey,
                  externalId: first.headRepositoryId!,
                  repository: first.headRepository!,
                  ...(first.headRef === undefined ? {} : { ref: first.headRef }),
                  sha: first.headSha,
                },
              },
              signal: controller.signal,
              deadlineMs: Date.now() + remaining,
            }),
            timeout,
          ])
        }
      } catch (error) {
        if (error instanceof SanitizationError) throw error
        codeManifest = undefined
      } finally {
        controller.abort()
        if (captureTimer !== undefined) clearTimeout(captureTimer)
      }
    }
    if (codeManifest !== undefined) {
      try {
        validateObjectRef(codeManifest)
        prepared.verifyCodeManifest(codeManifest)
        if (
          codeManifest.mediaType !== 'application/vnd.factory.code-manifest+json' ||
          codeManifest.role !== 'workspace-code-manifest'
        ) {
          codeManifest = undefined
        }
      } catch {
        codeManifest = undefined
      }
    }
    const refsComplete =
      first.baseRef !== undefined &&
      first.baseSha !== undefined &&
      headRepositoryKey !== undefined &&
      first.headRepository !== undefined &&
      first.headRef !== undefined &&
      first.headSha !== undefined
    const complete = first.commitsComplete && refsComplete
    const common = {
      schemaVersion: 1 as const,
      provider: 'github' as const,
      repositoryKey: baseRepositoryKey,
      number: ref.number,
      availability: 'available' as const,
      externalId: first.externalId,
      hostname: ref.hostname.toLowerCase(),
      url: first.url,
      state: first.state,
      base: {
        repositoryKey: baseRepositoryKey,
        externalId: first.repositoryId,
        repository: first.repository,
        ...(first.baseRef === undefined ? {} : { ref: first.baseRef }),
        ...(first.baseSha === undefined ? {} : { sha: first.baseSha }),
      },
      head: {
        ...(headRepositoryKey === undefined
          ? {}
          : {
              repositoryKey: headRepositoryKey,
              externalId: first.headRepositoryId!,
            }),
        ...(first.headRepository === undefined ? {} : { repository: first.headRepository }),
        ...(first.headRef === undefined ? {} : { ref: first.headRef }),
        ...(first.headSha === undefined ? {} : { sha: first.headSha }),
      },
      commits: first.commits,
      observedAt,
      providerUpdatedAt: first.updatedAt,
      evidence,
      transformation: prepared.transformation,
      codeAvailability:
        codeManifest !== undefined
          ? ('captured' as const)
          : this.options.captureCodeManifest === undefined
            ? ('not-requested' as const)
            : ('unavailable' as const),
      ...(codeManifest === undefined ? {} : { codeManifest }),
      diff,
      limitations: [
        ...(prepared.transformation.omissionReasons.length
          ? [
              {
                code: 'excluded-by-limit' as const,
                detail: 'Some GitHub evidence was omitted by the evidence sanitization policy',
              },
            ]
          : []),
        ...(first.commitsComplete
          ? []
          : [
              {
                code: 'incomplete-pull-request-commits' as const,
                detail: `Commit evidence reached the configured ${this.maxCommits}-commit or ${this.maxCommitPages}-page bound`,
              },
            ]),
        ...(refsComplete
          ? []
          : [
              {
                code: 'incomplete-pull-request-refs' as const,
                detail: 'GitHub no longer exposed every pull-request repository, ref, or object ID',
              },
            ]),
        ...(codeManifest === undefined && this.options.captureCodeManifest !== undefined
          ? [
              {
                code: 'unavailable-pull-request-code' as const,
                detail: 'Exact PR head code manifest was unavailable',
              },
            ]
          : []),
      ],
    }
    const observationId = recordId('pr-observation', observedAt, canonicalJson(common))
    const observation: AvailablePullRequestObservation = complete
      ? {
          ...common,
          observationId,
          completeness: 'complete',
          commitMembership: 'complete',
          base: common.base as Extract<
            AvailablePullRequestObservation,
            { completeness: 'complete' }
          >['base'],
          head: common.head as Extract<
            AvailablePullRequestObservation,
            { completeness: 'complete' }
          >['head'],
          commits: common.commits as [string, ...string[]],
        }
      : {
          ...common,
          observationId,
          completeness: 'partial',
          commitMembership: first.commitsComplete ? 'complete' : 'prefix',
        }
    try {
      validatePublicRecord(
        makeOwnedPath('pull-requests', [
          'github',
          observation.repositoryKey,
          String(observation.number),
          'observations',
          `${observation.observationId}.json`,
        ]),
        observation,
      )
    } catch {
      return unavailable(
        'invalid-response',
        'GitHub observation failed Factory contract validation',
      )
    }
    return observation
  }
}

export type GithubRepositoryMapperOptions = {
  sanitizer: Sanitizer
  run?: GhCommandRunner['run']
  objects: PrObjectStore
  maxCommandBytes?: number
  maxCommandDurationMs?: number
  maxAcquisitionDurationMs?: number
  now?: () => Date
  cwd?: string
  environment?: NodeJS.ProcessEnv
}

export type GithubRepositoryMappingUnavailable = {
  availability: 'unavailable'
  reason: PullRequestUnavailableReason
  repositoryId: RepositoryId
  observedAt: string
  detail: string
}

/** Observe the GitHub identity selected by `gh` for the current local repository. */
export async function observeGithubRepositoryMapping(
  repositoryId: RepositoryId,
  hostname: string,
  options: GithubRepositoryMapperOptions,
): Promise<GithubRepositoryMappingObservation | GithubRepositoryMappingUnavailable> {
  if (!/^repo_[A-Za-z0-9_-]+$/.test(repositoryId)) {
    throw new TypeError('Factory repository identity is invalid')
  }
  githubRepositoryKey(hostname, 'validate')
  requireUnchanged(options.sanitizer, [hostname])
  const maximumBytes = options.maxCommandBytes ?? 1024 * 1024
  const maximumDurationMs = options.maxCommandDurationMs ?? 30_000
  const maximumAcquisitionDurationMs = options.maxAcquisitionDurationMs ?? 60_000
  for (const [label, value] of [
    ['maxCommandBytes', maximumBytes],
    ['maxCommandDurationMs', maximumDurationMs],
    ['maxAcquisitionDurationMs', maximumAcquisitionDurationMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${label} must be a positive integer`)
    }
  }
  const run =
    options.run ??
    ((args: readonly string[], duration?: number) =>
      runBoundedGh(
        args,
        maximumBytes,
        duration ?? maximumDurationMs,
        'gh',
        options.cwd,
        options.environment,
      ))
  const observedAt = (options.now ?? (() => new Date()))().toISOString()
  const deadline = performance.now() + maximumAcquisitionDurationMs
  const execution = await settleWithinDeadline(
    () =>
      run(
        ['repo', 'view', '--json', 'id,nameWithOwner,url'],
        Math.min(maximumDurationMs, maximumAcquisitionDurationMs),
      ),
    deadline,
  )
  if (execution.kind !== 'completed') {
    return {
      availability: 'unavailable',
      reason: execution.kind === 'timeout' ? 'command-timeout' : 'command-failed',
      repositoryId,
      observedAt,
      detail: 'GitHub repository identity was unavailable',
    }
  }
  const result = execution.value
  if (result.stdout.byteLength + result.stderr.byteLength > maximumBytes) {
    return {
      availability: 'unavailable',
      reason: 'output-limit',
      repositoryId,
      observedAt,
      detail: 'GitHub repository identity exceeded the acquisition byte bound',
    }
  }
  if (result.kind !== 'completed' || result.exitCode !== 0) {
    return {
      availability: 'unavailable',
      reason: unavailableReason(result),
      repositoryId,
      observedAt,
      detail: 'GitHub repository identity was unavailable',
    }
  }
  let metadata: { id: string; nameWithOwner: string; url: string }
  try {
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(result.stdout),
    ) as Record<string, unknown>
    assertString(parsed.id, 'repository.id')
    assertString(parsed.nameWithOwner, 'repository.nameWithOwner')
    assertString(parsed.url, 'repository.url')
    if (!isGithubRepositoryLocator(parsed.nameWithOwner)) {
      throw new TypeError('repository.nameWithOwner is invalid')
    }
    const url = new URL(parsed.url)
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== hostname.toLowerCase() ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new TypeError('repository.url is outside the requested GitHub host')
    }
    if (url.pathname.replace(/\/$/, '') !== `/${parsed.nameWithOwner}`) {
      throw new TypeError('repository.url does not match repository.nameWithOwner')
    }
    metadata = {
      id: parsed.id,
      nameWithOwner: parsed.nameWithOwner,
      url: parsed.url,
    }
    requireUnchanged(options.sanitizer, [metadata.id, metadata.nameWithOwner, metadata.url])
  } catch {
    return {
      availability: 'unavailable',
      reason: 'invalid-response',
      repositoryId,
      observedAt,
      detail: 'GitHub returned malformed repository metadata',
    }
  }
  const prepared = new PreparedPrObjects(maximumBytes * 2)
  let evidenceBytes: Uint8Array
  try {
    evidenceBytes = prepareGithubMetadata(
      result.stdout,
      options.sanitizer,
      prepared.transformation,
      false,
    )
  } catch {
    return {
      availability: 'unavailable',
      reason: 'invalid-response',
      repositoryId,
      observedAt,
      detail: 'GitHub repository metadata could not be prepared',
    }
  }
  const evidence = await prepared.put(evidenceBytes, {
    mediaType: 'application/json',
    role: 'github-repository-metadata',
  })
  const repositoryKey = githubRepositoryKey(hostname, metadata.id)
  const observation: GithubRepositoryMappingObservation = {
    schemaVersion: 1,
    observationId: recordId(
      'github-repository-mapping',
      observedAt,
      canonicalJson({ repositoryId, repositoryKey, metadata, evidence: evidence.sha256 }),
    ),
    provider: 'github',
    repositoryId,
    repositoryKey,
    externalId: metadata.id,
    hostname: hostname.toLowerCase(),
    repository: metadata.nameWithOwner,
    url: metadata.url,
    observedAt,
    evidence: [evidence],
    transformation: prepared.transformation,
  }
  validatePublicRecord(
    makeOwnedPath('pull-requests', [
      'github',
      repositoryKey,
      'repository-mappings',
      repositoryId,
      `${observation.observationId}.json`,
    ]),
    observation,
  )
  const publication = await settleWithinDeadline(
    () => prepared.publish(options.objects, deadline),
    deadline,
  )
  if (publication.kind !== 'completed')
    return {
      availability: 'unavailable',
      reason: publication.kind === 'timeout' ? 'command-timeout' : 'command-failed',
      repositoryId,
      observedAt,
      detail: 'Prepared GitHub repository evidence could not be published',
    }
  return observation
}

export async function persistGithubRepositoryMapping(
  store: RepositoryStore,
  observation: GithubRepositoryMappingObservation,
  preparation: PublicationPreparation,
): Promise<void> {
  const path = makeOwnedPath('pull-requests', [
    'github',
    observation.repositoryKey,
    'repository-mappings',
    observation.repositoryId,
    `${observation.observationId}.json`,
  ])
  validatePublicRecord(path, observation)
  await store.createImmutable(
    preparation.prepareRecord(path, new TextEncoder().encode(canonicalJson(observation))),
  )
}

export async function persistPullRequestEvidence(
  store: RepositoryStore,
  observation: PullRequestObservation,
  associations: readonly SessionPullRequestAssociation[],
  options: { preparation: PublicationPreparation; policyVersion?: string },
): Promise<readonly AssociationBatch[]> {
  const root = ['github', observation.repositoryKey, String(observation.number)]
  if (observation.availability === 'unavailable' && associations.length !== 0) {
    throw new TypeError('unavailable pull requests cannot have associations')
  }
  const observationRecord = {
    path: makeOwnedPath('pull-requests', [
      ...root,
      'observations',
      `${observation.observationId}.json`,
    ]),
    bytes: new TextEncoder().encode(canonicalJson(observation)),
  }
  const records: {
    path: ReturnType<typeof makeOwnedPath>
    bytes: Uint8Array
  }[] = []
  for (const association of associations) {
    if (association.pullRequestObservationId !== observation.observationId) {
      throw new TypeError('association belongs to another pull-request observation')
    }
    records.push({
      path: makeOwnedPath('pull-requests', [
        ...root,
        'associations',
        observation.observationId,
        `${association.evidenceId}.json`,
      ]),
      bytes: new TextEncoder().encode(canonicalJson(association)),
    })
  }
  for (const record of [observationRecord, ...records]) {
    validatePublicRecord(record.path, JSON.parse(new TextDecoder().decode(record.bytes)))
  }
  const recordById = new Map(
    records.map((record, index) => [associations[index]!.evidenceId, record]),
  )
  const automatic = associations.filter(association => association.kind !== 'manual')
  const manualByTime = new Map<string, SessionPullRequestAssociation[]>()
  for (const association of associations.filter(candidate => candidate.kind === 'manual')) {
    const group = manualByTime.get(association.observedAt) ?? []
    group.push(association)
    manualByTime.set(association.observedAt, group)
  }
  const groups: {
    kind: 'automatic' | 'manual'
    associations: SessionPullRequestAssociation[]
  }[] = [
    ...(automatic.length === 0 ? [] : [{ kind: 'automatic' as const, associations: automatic }]),
    ...[...manualByTime.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, group]) => ({ kind: 'manual' as const, associations: group })),
  ]
  const batches: AssociationBatch[] = []
  const batchRecords: {
    path: ReturnType<typeof makeOwnedPath>
    bytes: Uint8Array
  }[] = []
  for (const group of groups) {
    const observedAts = new Set(group.associations.map(association => association.observedAt))
    if (observedAts.size !== 1) throw new TypeError('one association batch requires one timestamp')
    const evidence = group.associations
      .map(association => ({
        evidenceId: association.evidenceId,
        sha256: hash(
          recordById.get(association.evidenceId)!.bytes,
        ) as AssociationBatch['evidence'][number]['sha256'],
      }))
      .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    const sourceObservationIds = [
      ...new Set(group.associations.flatMap(association => association.sourceObservationIds)),
    ].sort()
    const policyVersion =
      options.policyVersion ?? (group.kind === 'manual' ? 'manual-v1' : 'factory-v1-exact-git-v1')
    const batchIdentity = canonicalJson({
      observationId: observation.observationId,
      kind: group.kind,
      evidence,
      sourceObservationIds,
      policyVersion,
    })
    const observedAt = group.associations[0]!.observedAt
    const batch: AssociationBatch = {
      schemaVersion: 1,
      batchId: recordId('association-batch', observedAt, batchIdentity),
      provider: 'github',
      repositoryKey: observation.repositoryKey,
      number: observation.number,
      pullRequestObservationId: observation.observationId,
      kind: group.kind,
      evidence,
      sourceObservationIds,
      observedAt,
      policyVersion,
    }
    const batchPath = makeOwnedPath('pull-requests', [
      ...root,
      'associations',
      observation.observationId,
      'batches',
      `${batch.batchId}.json`,
    ])
    validatePublicRecord(batchPath, batch)
    batchRecords.push({
      path: batchPath,
      bytes: new TextEncoder().encode(canonicalJson(batch)),
    })
    batches.push(batch)
  }
  const prepared = [observationRecord, ...records, ...batchRecords].map(record =>
    options.preparation.prepareRecord(record.path, record.bytes),
  )
  for (const record of prepared) await store.createImmutable(record)
  return batches
}
