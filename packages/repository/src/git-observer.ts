import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises'
import { relative } from 'node:path'

import {
  canonicalJson,
  decodeGitPath,
  encodeGitPath,
  newRecordId,
  parseCodeManifest,
  validateObjectRef,
  type CodeManifest,
  type CodeManifestEntry,
  type Limitation,
  type ObjectRef,
  type RepositoryId,
  type RepositoryObservation,
  type RecordId,
} from '@factory/contract'

import { ConfinedWriter } from './confined-writer'

export type RaceFact = {
  code: 'repository-changed-during-observation'
  startState: string
  endState: string
}

export type ObservationUnavailable = {
  code:
    | 'not-a-git-repository'
    | 'git-command-failed'
    | 'git-command-timeout'
    | 'git-output-limit'
    | 'checkout-moved'
  detail: string
}

export type ObservationResult =
  | { kind: 'observed'; observation: RepositoryObservation }
  | {
      kind: 'raced'
      partial: RepositoryObservation
      race: RaceFact
    }
  | { kind: 'unavailable'; reason: ObservationUnavailable }

export interface GitObjectStore {
  put(bytes: Uint8Array, metadata: { mediaType: string; role: string }): Promise<ObjectRef>
  /** Return bytes only after checking the reference digest and length. */
  get(ref: ObjectRef): Promise<Uint8Array>
}

export type GitObserverOptions = {
  repositoryId: RepositoryId
  maxFileBytes?: number
  maxObservationBytes?: number
  maxGitOutputBytes?: number
  maxGitDurationMs?: number
  /** Test seam used to make a race happen at the actual capture boundary. */
  afterCapture?: () => Promise<void>
  /** Test seam used to swap a destination after its directory descriptor is bound. */
  beforeReconstructionWrite?: () => Promise<void>
  now?: () => Date
  /** Recovery supplies one claim-derived identity so retries converge. */
  observationId?: RecordId
}

type GitCommand = 'for-each-ref' | 'config' | 'ls-files' | 'rev-parse' | 'symbolic-ref' | 'ls-tree'

const ALLOWED_GIT_COMMANDS = new Set<GitCommand>([
  'for-each-ref',
  'config',
  'ls-files',
  'rev-parse',
  'symbolic-ref',
  'ls-tree',
])
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_OBSERVATION_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_GIT_DURATION_MS = 30_000
const GIT_CONFIGURATION = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
] as const

export async function loadCodeManifestObject(
  ref: ObjectRef,
  readVerifiedObject: (ref: ObjectRef) => Promise<Uint8Array>,
  maximumBytes = DEFAULT_MAX_GIT_OUTPUT_BYTES,
): Promise<CodeManifest> {
  validateObjectRef(ref)
  if (
    ref.mediaType !== 'application/vnd.factory.code-manifest+json' ||
    ref.role !== 'workspace-code-manifest'
  ) {
    throw new TypeError('object reference does not identify a Factory code manifest')
  }
  if (ref.bytes > maximumBytes) throw new Error('code manifest exceeds loader limit')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await readVerifiedObject(ref))
  const value = JSON.parse(text) as unknown
  if (canonicalJson(value) !== text)
    throw new TypeError('code manifest object is not canonical JSON')
  return parseCodeManifest(value)
}

export type CodeReconstructionOptions = {
  maxFileBytes?: number
  maxTotalBytes?: number
  /** Test seam used to swap a destination after its directory descriptor is bound. */
  beforeWrite?: () => Promise<void>
}

/** Reconstruct verified CAS-backed code without consulting a live checkout or Git metadata. */
export async function reconstructCodeManifest(
  manifest: CodeManifest,
  destination: string,
  readVerifiedObject: (reference: ObjectRef) => Promise<Uint8Array>,
  options: CodeReconstructionOptions = {},
): Promise<void> {
  parseCodeManifest(manifest)
  const plan = manifest.entries.map(entry => {
    const path = Buffer.from(decodeGitPath(entry.path))
    validateRelativePath(path)
    if (entry.kind === 'gitlink')
      throw new Error('submodule content is unavailable for reconstruction')
    if (entry.object === undefined) throw new Error('code manifest entry has no object')
    return {
      kind: entry.kind,
      mode: entry.mode,
      object: { ...entry.object },
      path: splitByte(path, 47).map(segment => Buffer.from(segment)),
      pathBytes: path,
    }
  })
  const destinationState = await lstat(destination, { bigint: true })
  if (destinationState.isSymbolicLink())
    throw new Error('reconstruction destination cannot be a symbolic link')
  const root = await realpath(destination)
  const resolvedState = await lstat(root, { bigint: true })
  if (!resolvedState.isDirectory() || !sameMetadata(destinationState, resolvedState)) {
    throw new Error('reconstruction destination changed while resolving')
  }
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_OBSERVATION_BYTES
  let inventoryBytes = 0
  const links = new Map<string, Buffer | undefined>()
  const linkTargets = new Map<string, Uint8Array>()
  for (const entry of plan) {
    inventoryBytes += entry.object.bytes
    if (entry.object.bytes > maxFileBytes || inventoryBytes > maxTotalBytes) {
      throw new Error('code manifest exceeds reconstruction limits')
    }
    if (entry.kind === 'symlink') {
      const target = Buffer.from(await readVerifiedObject(entry.object))
      const key = pathKey(entry.pathBytes)
      links.set(key, resolveLink(entry.pathBytes, target))
      linkTargets.set(key, target)
    }
  }
  for (const key of links.keys()) {
    const issue = linkGraphIssue(key, links)
    if (issue !== undefined) throw new Error(`${issue} symlink cannot be reconstructed: ${key}`)
  }
  const writer = await ConfinedWriter.open(root, resolvedState)
  try {
    await options.beforeWrite?.()
    await writer.assertEmpty()
    for (const entry of plan) {
      if (entry.kind === 'symlink') continue
      await writer.writeFile(
        entry.path,
        await readVerifiedObject(entry.object),
        entry.mode === '100755' ? 0o755 : 0o644,
      )
    }
    for (const entry of plan) {
      if (entry.kind !== 'symlink') continue
      await writer.symlink(entry.path, linkTargets.get(pathKey(entry.pathBytes))!)
    }
    await writer.assertExact(
      plan.map(entry => ({
        path: entry.path,
        kind: entry.kind === 'symlink' ? 'symlink' : 'file',
        mode: entry.mode === '100755' ? 0o755 : 0o644,
        bytes: entry.object.bytes,
        sha256: entry.object.sha256,
      })),
    )
    const finalState = await lstat(destination, { bigint: true })
    if (!finalState.isDirectory() || !sameFileIdentity(resolvedState, finalState)) {
      throw new Error('reconstruction destination changed while writing')
    }
  } finally {
    await writer.close()
  }
}

class GitOutputLimitError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`Git output exceeds ${maximumBytes} bytes`)
    this.name = 'GitOutputLimitError'
  }
}

class GitTimeoutError extends Error {
  constructor(readonly maximumMs: number) {
    super(`Git command exceeded ${maximumMs} milliseconds`)
    this.name = 'GitTimeoutError'
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(parts.map(part => Buffer.from(part)))
}

function splitNull(bytes: Uint8Array): Buffer[] {
  const value = Buffer.from(bytes)
  const fields: Buffer[] = []
  let start = 0
  for (let index = 0; index < value.byteLength; index += 1) {
    if (value[index] === 0) {
      if (index > start) fields.push(value.subarray(start, index))
      start = index + 1
    }
  }
  if (start < value.byteLength) fields.push(value.subarray(start))
  return fields
}

function displayPath(path: Uint8Array): string | undefined {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(path)
    return decoded.includes('\u0000') ? undefined : decoded
  } catch {
    return undefined
  }
}

function pathKey(path: Uint8Array): string {
  return Buffer.from(path).toString('base64')
}

function isFactoryPath(path: Uint8Array): boolean {
  const bytes = Buffer.from(path)
  return (
    bytes.equals(Buffer.from('.factory')) || bytes.subarray(0, 9).equals(Buffer.from('.factory/'))
  )
}

function isGitLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.some(byte => byte > 0x7f)) return false
  return /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize (?:0|[1-9]\d*)\n$/.test(
    Buffer.from(bytes).toString('ascii'),
  )
}

function bytePath(root: string, relative: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(root), Buffer.from('/'), Buffer.from(relative)])
}

function sameMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
  )
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function updateFingerprint(
  state: ReturnType<typeof createHash>,
  path: Uint8Array,
  kind: string,
  mode: number,
  contentDigest?: string,
): void {
  for (const value of [
    path,
    Buffer.from(kind),
    Buffer.from(String(mode)),
    Buffer.from(contentDigest ?? ''),
  ]) {
    const length = Buffer.allocUnsafe(8)
    length.writeBigUInt64BE(BigInt(value.byteLength))
    state.update(length).update(value)
  }
}

function fingerprint(path: Uint8Array, kind: string, mode: number, contentDigest?: string): string {
  const state = createHash('sha256')
  updateFingerprint(state, path, kind, mode, contentDigest)
  return state.digest('hex')
}

function decodeUtf8(bytes: Uint8Array, subject: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${subject} is not valid UTF-8`)
  }
}

function gitBlobDigest(bytes: Uint8Array, algorithm: 'sha1' | 'sha256'): string {
  return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

function isAtOrWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith('../') && path !== '..')
}

function validateRelativePath(path: Uint8Array): void {
  const bytes = Buffer.from(path)
  if (bytes.byteLength === 0 || bytes[0] === 47 || bytes.includes(0)) {
    throw new Error('Git manifest contains an unsafe path')
  }
  const segments = splitByte(bytes, 47)
  if (
    segments.some(
      segment =>
        segment.byteLength === 0 ||
        segment.equals(Buffer.from('.')) ||
        segment.equals(Buffer.from('..')),
    )
  ) {
    throw new Error('Git manifest contains path traversal')
  }
}

function splitByte(value: Buffer, separator: number): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  for (let index = 0; index <= value.byteLength; index += 1) {
    if (index === value.byteLength || value[index] === separator) {
      parts.push(value.subarray(start, index))
      start = index + 1
    }
  }
  return parts
}

function joinSegments(segments: readonly Buffer[]): Buffer {
  return Buffer.from(
    segments.reduce<number[]>((all, segment, index) => {
      if (index > 0) all.push(47)
      all.push(...segment)
      return all
    }, []),
  )
}

function resolveLink(path: Uint8Array, target: Uint8Array): Buffer | undefined {
  const targetBytes = Buffer.from(target)
  if (targetBytes.byteLength === 0 || targetBytes[0] === 47 || targetBytes.includes(0))
    return undefined
  const pathSegments = splitByte(Buffer.from(path), 47)
  pathSegments.pop()
  for (const segment of splitByte(targetBytes, 47)) {
    if (segment.byteLength === 0 || segment.equals(Buffer.from('.'))) continue
    if (segment.equals(Buffer.from('..'))) {
      if (pathSegments.length === 0) return undefined
      pathSegments.pop()
    } else {
      pathSegments.push(segment)
    }
  }
  const resolved = joinSegments(pathSegments)
  const ancestors = splitByte(Buffer.from(path), 47)
  ancestors.pop()
  while (true) {
    const ancestor = joinSegments(ancestors)
    if (resolved.equals(ancestor)) return undefined
    if (ancestors.length === 0) break
    ancestors.pop()
  }
  return resolved
}

function linkGraphIssue(
  start: string,
  links: ReadonlyMap<string, Buffer | undefined>,
): 'unsafe' | 'cyclic' | undefined {
  const first = links.get(start)
  if (first === undefined) return 'unsafe'
  const seen = new Set([start])
  let current = first
  for (;;) {
    const segments = splitByte(current, 47)
    let followed = false
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = joinSegments(segments.slice(0, length))
      const key = pathKey(prefix)
      if (!links.has(key)) continue
      if (seen.has(key)) return 'cyclic'
      seen.add(key)
      const target = links.get(key)
      if (target === undefined) return 'unsafe'
      current = joinSegments([...splitByte(target, 47), ...segments.slice(length)])
      followed = true
      break
    }
    if (!followed) return undefined
  }
}

async function lockPathParents(
  root: string,
  relativePath: Uint8Array,
): Promise<Array<{ path: Buffer; stats: BigIntStats }>> {
  validateRelativePath(relativePath)
  const segments = splitByte(Buffer.from(relativePath), 47)
  segments.pop()
  const parents: Array<{ path: Buffer; stats: BigIntStats }> = []
  let current = Buffer.from(root)
  for (const segment of segments) {
    current = Buffer.concat([current, Buffer.from('/'), segment])
    const stats = await lstat(current, { bigint: true })
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Git path has a non-directory or symbolic parent: ${pathKey(relativePath)}`)
    }
    parents.push({ path: current, stats })
  }
  return parents
}

async function assertParentsUnchanged(
  parents: readonly { path: Buffer; stats: BigIntStats }[],
): Promise<void> {
  for (const parent of parents) {
    const after = await lstat(parent.path, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink() || !sameMetadata(parent.stats, after)) {
      throw new Error('Git path parent changed while reading')
    }
  }
}

export class GitObserver {
  private readonly maxFileBytes: number
  private readonly maxObservationBytes: number
  private readonly maxGitOutputBytes: number
  private readonly maxGitDurationMs: number
  private readonly now: () => Date

  constructor(
    private readonly repositoryRoot: string,
    private readonly objects: GitObjectStore,
    private readonly options: GitObserverOptions,
  ) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.maxObservationBytes = options.maxObservationBytes ?? DEFAULT_MAX_OBSERVATION_BYTES
    this.maxGitOutputBytes = options.maxGitOutputBytes ?? DEFAULT_MAX_GIT_OUTPUT_BYTES
    this.maxGitDurationMs = options.maxGitDurationMs ?? DEFAULT_MAX_GIT_DURATION_MS
    if (
      this.maxFileBytes < 1 ||
      this.maxObservationBytes < 1 ||
      this.maxGitOutputBytes < 1 ||
      this.maxGitDurationMs < 1
    ) {
      throw new TypeError('Git observation limits must be positive')
    }
    this.now = options.now ?? (() => new Date())
  }

  private async git(
    command: GitCommand,
    args: readonly string[],
    allowedExitCodes: readonly number[] = [],
  ): Promise<Uint8Array> {
    if (!ALLOWED_GIT_COMMANDS.has(command))
      throw new Error(`Git operation is not read-only: ${command}`)
    const child = Bun.spawn(['git', ...GIT_CONFIGURATION, command, ...args], {
      cwd: this.repositoryRoot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
        ...(process.env.XDG_CONFIG_HOME === undefined
          ? {}
          : { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const readBounded = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
      const chunks: Uint8Array[] = []
      let bytes = 0
      for await (const chunk of stream) {
        bytes += chunk.byteLength
        if (bytes > this.maxGitOutputBytes) throw new GitOutputLimitError(this.maxGitOutputBytes)
        chunks.push(chunk.slice())
      }
      return concatenate(chunks)
    }
    const stdoutPromise = readBounded(child.stdout)
    const stderrPromise = readBounded(child.stderr)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new GitTimeoutError(this.maxGitDurationMs)),
        this.maxGitDurationMs,
      )
    })
    let exitCode: number
    let stdout: Uint8Array
    let stderrBytes: Uint8Array
    try {
      ;[exitCode, stdout, stderrBytes] = await Promise.race([
        Promise.all([child.exited, stdoutPromise, stderrPromise]),
        deadline,
      ])
    } catch (error) {
      child.kill(9)
      await Promise.allSettled([child.exited, stdoutPromise, stderrPromise])
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    const stderr = decodeUtf8(stderrBytes, `git ${command} stderr`)
    if (exitCode !== 0 && !allowedExitCodes.includes(exitCode)) {
      throw new Error(`git ${command} failed: ${stderr.trim()}`)
    }
    return exitCode === 0 ? stdout : new Uint8Array()
  }

  private async readVerifiedObject(ref: ObjectRef): Promise<Uint8Array> {
    validateObjectRef(ref)
    const bytes = await this.objects.get(ref)
    if (bytes.byteLength !== ref.bytes || hash(bytes) !== ref.sha256) {
      throw new Error(`object is unavailable or corrupt: ${ref.sha256}`)
    }
    return bytes
  }

  private async sentinel(): Promise<{
    state: string
    worktree: string
    pathStates: ReadonlyMap<string, string>
  }> {
    const head = await this.git('rev-parse', ['--verify', '-q', 'HEAD'], [1])
    const branch = await this.git('symbolic-ref', ['-q', 'HEAD'], [1])
    const refs = await this.git('for-each-ref', ['--format=%(refname)%00%(objectname)'])
    const config = await this.git('config', ['--local', '--null', '--list'])
    const indexPathBytes = await this.git('rev-parse', ['--git-path', 'index'])
    const worktree = await this.filesystemState()
    const indexPath = decodeUtf8(indexPathBytes, 'Git index path').trim()
    let index = new Uint8Array()
    try {
      index = await readFile(
        indexPath.startsWith('/') ? indexPath : `${this.repositoryRoot}/${indexPath}`,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const state = createHash('sha256')
    updateFingerprint(state, head, 'head', 0)
    updateFingerprint(state, branch, 'branch', 0)
    updateFingerprint(state, refs, 'refs', 0)
    updateFingerprint(state, config, 'config', 0)
    updateFingerprint(state, index, 'index', 0)
    updateFingerprint(state, Buffer.from(worktree.digest), 'worktree', 0)
    return {
      state: state.digest('hex'),
      worktree: worktree.digest,
      pathStates: worktree.pathStates,
    }
  }

  private async indexDigest(): Promise<string | undefined> {
    const pathBytes = await this.git('rev-parse', ['--git-path', 'index'])
    const path = decodeUtf8(pathBytes, 'Git index path').trim()
    try {
      return hash(await readFile(path.startsWith('/') ? path : `${this.repositoryRoot}/${path}`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async filesystemState(): Promise<{
    digest: string
    pathStates: ReadonlyMap<string, string>
  }> {
    const tracked = await this.git('ls-files', ['--cached', '-z'])
    const untracked = await this.git('ls-files', ['--others', '--exclude-standard', '-z'])
    const paths = [
      ...new Map(
        [...splitNull(tracked), ...splitNull(untracked)]
          .filter(path => !isFactoryPath(path))
          .map(path => [pathKey(path), path]),
      ).values(),
    ].sort(Buffer.compare)
    const hashState = createHash('sha256')
    const pathStates = new Map<string, string>()
    for (const path of paths) {
      try {
        const scanned = await this.capturePath(path, false)
        const value = fingerprint(path, scanned.kind, scanned.mode, scanned.digest)
        pathStates.set(pathKey(path), value)
        updateFingerprint(hashState, path, scanned.kind, scanned.mode, value)
        if (scanned.raced) updateFingerprint(hashState, path, 'raced', scanned.mode)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const value = fingerprint(
          path,
          code === 'ENOENT' ? 'missing' : 'unreadable',
          0,
          code === 'ENOENT' ? undefined : code,
        )
        pathStates.set(pathKey(path), value)
        updateFingerprint(hashState, path, code === 'ENOENT' ? 'missing' : 'unreadable', 0, value)
      }
    }
    return { digest: hashState.digest('hex'), pathStates }
  }

  private async capturePath(
    path: Uint8Array,
    retain = true,
    gitAlgorithm?: 'sha1' | 'sha256',
  ): Promise<{
    bytes?: Uint8Array
    digest?: string
    gitDigest?: string
    kind: 'file' | 'symlink' | 'other'
    mode: number
    raced: boolean
  }> {
    const parents = await lockPathParents(this.repositoryRoot, path)
    const absolute = bytePath(this.repositoryRoot, path)
    const before = await lstat(absolute, { bigint: true })
    if (before.isSymbolicLink()) {
      const bytes = await readlink(absolute, { encoding: 'buffer' })
      const after = await lstat(absolute, { bigint: true })
      await assertParentsUnchanged(parents)
      return {
        ...(retain && bytes.byteLength <= this.maxFileBytes ? { bytes } : {}),
        digest: hash(bytes),
        ...(gitAlgorithm === undefined ? {} : { gitDigest: gitBlobDigest(bytes, gitAlgorithm) }),
        kind: 'symlink',
        mode: Number(before.mode),
        raced: !sameMetadata(before, after),
      }
    }
    if (!before.isFile()) {
      return { kind: 'other', mode: Number(before.mode), raced: false }
    }
    const chunks: Buffer[] = []
    const digest = createHash('sha256')
    let total = 0
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile()) throw new Error('Git path changed type while opening')
      const gitDigest =
        gitAlgorithm === undefined
          ? undefined
          : createHash(gitAlgorithm).update(`blob ${opened.size.toString()}\0`)
      let excluded = opened.size > BigInt(this.maxFileBytes)
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxFileBytes + 1))
      while (!excluded) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, this.maxFileBytes - total + 1),
          null,
        )
        if (bytesRead === 0) break
        total += bytesRead
        if (total > this.maxFileBytes) {
          excluded = true
          break
        }
        const chunk = buffer.subarray(0, bytesRead)
        digest.update(chunk)
        gitDigest?.update(chunk)
        if (retain) chunks.push(Buffer.from(chunk))
      }
      const closed = await handle.stat({ bigint: true })
      const after = await lstat(absolute, { bigint: true })
      await assertParentsUnchanged(parents)
      return {
        ...(retain && !excluded ? { bytes: Buffer.concat(chunks) } : {}),
        // Excluded bytes have no content identity. Their metadata still participates
        // in the race sentinel, without hashing a file we cannot admit as evidence.
        digest: excluded
          ? `excluded:${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeNs}:${opened.ctimeNs}:${opened.mode}`
          : digest.digest('hex'),
        ...(gitDigest === undefined || excluded ? {} : { gitDigest: gitDigest.digest('hex') }),
        kind: 'file',
        mode: Number(opened.mode),
        raced:
          !sameMetadata(before, opened) ||
          !sameMetadata(opened, closed) ||
          !sameMetadata(closed, after),
      }
    } finally {
      await handle.close()
    }
  }

  async observe(): Promise<ObservationResult> {
    let resolved: string
    try {
      resolved = await realpath(this.repositoryRoot)
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: { code: 'checkout-moved', detail: (error as Error).message },
      }
    }
    if (resolved !== this.repositoryRoot) {
      return {
        kind: 'unavailable',
        reason: { code: 'checkout-moved', detail: 'checkout path is not canonical' },
      }
    }
    try {
      const gitEntry = await lstat(`${this.repositoryRoot}/.git`)
      if (gitEntry.isSymbolicLink() || (!gitEntry.isDirectory() && !gitEntry.isFile())) {
        throw new Error('checkout root has an unsafe .git entry')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          kind: 'unavailable',
          reason: {
            code: 'not-a-git-repository',
            detail: 'checkout root has no .git entry',
          },
        }
      }
      return {
        kind: 'unavailable',
        reason: { code: 'git-command-failed', detail: (error as Error).message },
      }
    }
    try {
      await this.git('rev-parse', ['--git-dir'])
    } catch (error) {
      const detail = (error as Error).message
      return {
        kind: 'unavailable',
        reason: {
          code:
            error instanceof GitOutputLimitError
              ? 'git-output-limit'
              : error instanceof GitTimeoutError
                ? 'git-command-timeout'
                : 'git-command-failed',
          detail,
        },
      }
    }

    try {
      const observedAt = this.now().toISOString()
      const start = await this.sentinel()
      const headBytes = await this.git('rev-parse', ['--verify', '-q', 'HEAD'], [1])
      const branchBytes = await this.git('symbolic-ref', ['--short', '-q', 'HEAD'], [1])
      const objectFormatBytes = await this.git('rev-parse', ['--show-object-format'])
      const indexEntries = await this.git('ls-files', ['--cached', '--stage', '-z'])
      const headEntries =
        headBytes.byteLength === 0
          ? new Uint8Array()
          : await this.git('ls-tree', ['-r', '-z', 'HEAD'])
      const sparseEntries = await this.git('ls-files', ['--cached', '-v', '-z'])
      const untracked = await this.git('ls-files', ['--others', '--exclude-standard', '-z'])
      const ignored = await this.git('ls-files', [
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
      ])
      const indexDigest = await this.indexDigest()
      const objectFormat = decodeUtf8(objectFormatBytes, 'Git object format').trim()
      if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
        throw new Error(`unsupported Git object format: ${objectFormat}`)
      }
      const limitations: Limitation[] = []
      const ignoredPaths = splitNull(ignored).filter(path => !isFactoryPath(path))
      if (ignoredPaths.length > 0) {
        limitations.push({
          code: 'unavailable-git-state',
          detail: `${ignoredPaths.length} ignored path(s) excluded`,
        })
      }
      const sparsePaths = new Set(
        splitNull(sparseEntries)
          .filter(field => field[0] === 83 && field[1] === 32)
          .map(field => pathKey(field.subarray(2))),
      )
      const staged = new Map<
        string,
        { path: Buffer; mode: CodeManifestEntry['mode']; oid: string }
      >()
      const headTree = new Map<string, { path: Buffer; mode: string; oid: string }>()
      for (const field of splitNull(headEntries)) {
        const tab = field.indexOf(9)
        if (tab < 0) throw new Error('Git tree output is malformed')
        const metadata = field.subarray(0, tab).toString('ascii').split(' ')
        const path = field.subarray(tab + 1)
        if (metadata.length !== 3 || (metadata[1] !== 'blob' && metadata[1] !== 'commit')) {
          throw new Error('Git tree output is malformed')
        }
        if (!isFactoryPath(path)) {
          headTree.set(pathKey(path), { path, mode: metadata[0]!, oid: metadata[2]! })
        }
      }
      const conflicted = new Map<string, Buffer>()
      for (const field of splitNull(indexEntries)) {
        const tab = field.indexOf(9)
        if (tab < 0) continue
        const metadata = field.subarray(0, tab).toString('ascii').split(' ')
        const path = field.subarray(tab + 1)
        if (isFactoryPath(path)) continue
        if (metadata[2] !== '0') {
          if (!conflicted.has(pathKey(path))) {
            conflicted.set(pathKey(path), path)
            limitations.push({
              code: 'unavailable-git-state',
              detail: `unmerged index state: ${pathKey(path)}`,
            })
          }
          continue
        }
        const mode = metadata[0] as CodeManifestEntry['mode']
        staged.set(pathKey(path), {
          path,
          mode,
          oid: metadata[1] ?? '',
        })
      }
      const paths = new Map<
        string,
        { path: Buffer; mode?: CodeManifestEntry['mode']; oid?: string }
      >()
      staged.forEach((entry, key) => paths.set(key, entry))
      conflicted.forEach((path, key) => paths.set(key, { path }))
      for (const path of splitNull(untracked)) {
        if (!isFactoryPath(path)) paths.set(pathKey(path), { path })
      }

      const pendingEntries: Array<
        | CodeManifestEntry
        | ({ path: CodeManifestEntry['path']; bytes: Uint8Array } & (
            | { mode: '100644' | '100755'; kind: 'file' | 'lfs-pointer' }
            | { mode: '120000'; kind: 'symlink' }
          ))
      > = []
      const symlinkTargets = new Map<string, Buffer | undefined>()
      let pathRace = false
      const capturedPathStates = new Map<string, string>()
      const changedPathMap = new Map<string, Buffer>()
      for (const [key, headEntry] of headTree) {
        const indexEntry = staged.get(key)
        if (
          indexEntry === undefined ||
          indexEntry.mode !== headEntry.mode ||
          indexEntry.oid !== headEntry.oid
        ) {
          changedPathMap.set(key, headEntry.path)
        }
      }
      for (const [key, indexEntry] of staged) {
        const headEntry = headTree.get(key)
        if (
          headEntry === undefined ||
          indexEntry.mode !== headEntry.mode ||
          indexEntry.oid !== headEntry.oid
        ) {
          changedPathMap.set(key, indexEntry.path)
        }
      }
      for (const [key, path] of conflicted) changedPathMap.set(key, path)
      for (const path of splitNull(untracked)) {
        if (!isFactoryPath(path)) changedPathMap.set(pathKey(path), path)
      }
      let observationBytes = 0
      for (const candidate of [...paths.values()].sort((left, right) =>
        Buffer.compare(left.path, right.path),
      )) {
        validateRelativePath(candidate.path)
        if (candidate.mode === '160000') {
          if (candidate.oid === undefined) throw new Error('Gitlink has no object identity')
          pendingEntries.push({
            path: encodeGitPath(candidate.path, displayPath(candidate.path)),
            mode: '160000',
            kind: 'gitlink',
            gitObject: candidate.oid,
          })
          limitations.push({
            code: 'unavailable-git-state',
            detail: `submodule content not captured: ${pathKey(candidate.path)}`,
          })
          continue
        }
        let captured
        try {
          captured = await this.capturePath(candidate.path, true, objectFormat)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            const code = (error as NodeJS.ErrnoException).code ?? 'read-failed'
            limitations.push({
              code: 'unavailable-git-state',
              detail: `unreadable workspace path (${code}): ${pathKey(candidate.path)}`,
            })
            if ((error as Error).message.includes('changed while reading')) pathRace = true
            continue
          }
          capturedPathStates.set(pathKey(candidate.path), fingerprint(candidate.path, 'missing', 0))
          if (sparsePaths.has(pathKey(candidate.path))) {
            limitations.push({
              code: 'unavailable-git-state',
              detail: `sparse tracked path absent: ${pathKey(candidate.path)}`,
            })
          } else if (candidate.oid !== undefined) {
            changedPathMap.set(pathKey(candidate.path), candidate.path)
          }
          continue
        }
        if (captured.kind === 'other') {
          limitations.push({
            code: 'unavailable-git-state',
            detail: `unsupported filesystem entry: ${pathKey(candidate.path)}`,
          })
          continue
        }
        if (captured.raced) {
          pathRace = true
          limitations.push({
            code: 'repository-race',
            detail: `path changed while read: ${pathKey(candidate.path)}`,
          })
        }
        if (captured.digest === undefined) throw new Error('captured file has no digest')
        capturedPathStates.set(
          pathKey(candidate.path),
          fingerprint(candidate.path, captured.kind, captured.mode, captured.digest),
        )
        if (candidate.oid !== undefined) {
          const worktreeMode =
            captured.kind === 'symlink'
              ? '120000'
              : (captured.mode & 0o100) !== 0
                ? '100755'
                : '100644'
          if (
            worktreeMode !== candidate.mode ||
            (captured.gitDigest !== undefined && captured.gitDigest !== candidate.oid)
          ) {
            changedPathMap.set(pathKey(candidate.path), candidate.path)
          }
        }
        const bytes = captured.bytes
        if (bytes === undefined) {
          limitations.push({
            code: 'excluded-by-limit',
            detail: `file exceeds ${this.maxFileBytes} bytes: ${pathKey(candidate.path)}`,
          })
          continue
        }
        if (observationBytes + bytes.byteLength > this.maxObservationBytes) {
          limitations.push({
            code: 'excluded-by-limit',
            detail: `workspace exceeds ${this.maxObservationBytes} captured bytes at: ${pathKey(candidate.path)}`,
          })
          continue
        }
        observationBytes += bytes.byteLength
        const isLink = captured.kind === 'symlink'
        const path = encodeGitPath(candidate.path, displayPath(candidate.path))
        if (isLink) {
          pendingEntries.push({ path, mode: '120000', kind: 'symlink', bytes })
        } else {
          pendingEntries.push({
            path,
            mode: (captured.mode & 0o100) !== 0 ? '100755' : '100644',
            kind: isGitLfsPointer(bytes) ? 'lfs-pointer' : 'file',
            bytes,
          })
        }
        if (isLink) symlinkTargets.set(pathKey(candidate.path), resolveLink(candidate.path, bytes))
      }
      for (const key of symlinkTargets.keys()) {
        const issue = linkGraphIssue(key, symlinkTargets)
        if (issue === 'unsafe')
          limitations.push({
            code: 'unavailable-git-state',
            detail: `unsafe symlink cannot be reconstructed: ${key}`,
          })
        else if (issue === 'cyclic')
          limitations.push({
            code: 'unavailable-git-state',
            detail: `cyclic symlink cannot be reconstructed: ${key}`,
          })
      }
      const changedPaths = [...changedPathMap.values()]
        .sort(Buffer.compare)
        .map(path => encodeGitPath(path, displayPath(path)))
      await this.options.afterCapture?.()
      const end = await this.sentinel()
      for (const [key, captured] of capturedPathStates) {
        if (end.pathStates.get(key) !== captured) pathRace = true
      }
      parseCodeManifest({
        schemaVersion: 1,
        entries: pendingEntries.map(pending => {
          if (!('bytes' in pending)) return pending
          const object: ObjectRef = {
            algorithm: 'sha256',
            sha256: hash(pending.bytes),
            bytes: pending.bytes.byteLength,
            mediaType:
              pending.kind === 'symlink'
                ? 'application/vnd.factory.symlink-target'
                : 'application/octet-stream',
            role: pending.kind === 'lfs-pointer' ? 'git-lfs-pointer' : 'workspace-file',
          }
          return pending.kind === 'symlink'
            ? { path: pending.path, mode: '120000', kind: 'symlink', object }
            : { path: pending.path, mode: pending.mode, kind: pending.kind, object }
        }),
        limitations,
      })
      const entries: CodeManifestEntry[] = []
      for (const pending of pendingEntries) {
        if (!('bytes' in pending)) {
          entries.push(pending)
          continue
        }
        const object = await this.objects.put(pending.bytes, {
          mediaType:
            pending.kind === 'symlink'
              ? 'application/vnd.factory.symlink-target'
              : 'application/octet-stream',
          role: pending.kind === 'lfs-pointer' ? 'git-lfs-pointer' : 'workspace-file',
        })
        entries.push(
          pending.kind === 'symlink'
            ? { path: pending.path, mode: '120000', kind: 'symlink', object }
            : {
                path: pending.path,
                mode: pending.mode,
                kind: pending.kind,
                object,
              },
        )
        if (pending.kind === 'lfs-pointer') {
          limitations.push({
            code: 'unavailable-git-state',
            detail: `LFS pointer preserved without fetching content: ${pending.path.bytes}`,
            object,
          })
        }
      }
      const manifest: CodeManifest = { schemaVersion: 1, entries, limitations }
      parseCodeManifest(manifest)
      const codeManifest = await this.objects.put(
        new TextEncoder().encode(canonicalJson(manifest)),
        {
          mediaType: 'application/vnd.factory.code-manifest+json',
          role: 'workspace-code-manifest',
        },
      )
      const head = decodeUtf8(headBytes, 'Git HEAD').trim() || undefined
      const branch = decodeUtf8(branchBytes, 'Git branch').trim() || undefined
      const observation: RepositoryObservation = {
        schemaVersion: 1,
        observationId: this.options.observationId ?? newRecordId('observation'),
        repositoryId: this.options.repositoryId,
        observedAt,
        completedAt: this.now().toISOString(),
        git: {
          ...(head ? { head } : {}),
          ...(branch ? { branch } : {}),
          detached: head !== undefined && branch === undefined,
          ...(indexDigest ? { index: indexDigest } : {}),
        },
        changedPaths,
        worktreeFingerprint: hash(new TextEncoder().encode(canonicalJson(manifest))),
        codeManifest,
        limitations:
          start.state === end.state && !pathRace
            ? limitations
            : [
                ...limitations,
                { code: 'repository-race', detail: 'Git state changed during observation' },
              ],
        startState: start.state,
        endState: end.state,
      }
      return start.state === end.state && !pathRace
        ? { kind: 'observed', observation }
        : {
            kind: 'raced',
            partial: observation,
            race: {
              code: 'repository-changed-during-observation',
              startState: start.state,
              endState: end.state,
            },
          }
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: {
          code:
            error instanceof GitOutputLimitError
              ? 'git-output-limit'
              : error instanceof GitTimeoutError
                ? 'git-command-timeout'
                : 'git-command-failed',
          detail: (error as Error).message,
        },
      }
    }
  }

  async reconstruct(manifest: CodeManifest, destination: string): Promise<void> {
    const destinationState = await lstat(destination, { bigint: true })
    if (destinationState.isSymbolicLink())
      throw new Error('reconstruction destination cannot be a symbolic link')
    const root = await realpath(destination)
    const resolvedState = await lstat(root, { bigint: true })
    if (!resolvedState.isDirectory() || !sameMetadata(destinationState, resolvedState)) {
      throw new Error('reconstruction destination changed while resolving')
    }
    const gitDirectory = decodeUtf8(
      await this.git('rev-parse', ['--path-format=absolute', '--git-dir']),
      'Git directory',
    ).trim()
    const commonDirectory = decodeUtf8(
      await this.git('rev-parse', ['--path-format=absolute', '--git-common-dir']),
      'Git common directory',
    ).trim()
    if (isAtOrWithin(gitDirectory, root) || isAtOrWithin(commonDirectory, root)) {
      throw new Error('reconstruction destination cannot enter Git metadata')
    }
    await reconstructCodeManifest(
      manifest,
      destination,
      async reference => await this.readVerifiedObject(reference),
      {
        maxFileBytes: this.maxFileBytes,
        maxTotalBytes: this.maxObservationBytes,
        beforeWrite: this.options.beforeReconstructionWrite,
      },
    )
  }

  async loadCodeManifest(ref: ObjectRef): Promise<CodeManifest> {
    return await loadCodeManifestObject(
      ref,
      async reference => await this.readVerifiedObject(reference),
      this.maxGitOutputBytes,
    )
  }
}
