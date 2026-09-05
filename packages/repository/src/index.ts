import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

import {
  assertNoMachinePaths,
  assertOwnedRecordPath,
  canonicalJson,
  makeOwnedPath,
  objectOwnedPath,
  parseRepositoryConfig,
  parseRepositoryManifest,
  validateObjectRef,
  validatePublicRecord,
  type JsonValue,
  type CoverageAction,
  type DecisionAction,
  type ObjectRef,
  type OwnedPath,
  type RepositoryConfig,
  type RepositoryManifest,
  type RepositoryRecords as ContractRepositoryRecords,
  type Sha256,
} from '@factory/contract'

import { withAdvisoryFileLock } from './confined-writer'

export {
  inventoryConfinedTree,
  readConfinedFile,
  withAdvisoryFileLock,
  type ConfinedReadOptions,
} from './confined-writer'

export * from './git-observer'
export { ReconstructionUnavailableError } from './confined-writer'

export type RecordRef = {
  path: OwnedPath
  sha256: string
  bytes: number
}

export type ImmutableGroupRecord = { path: OwnedPath; bytes: Uint8Array }

export type ReviewPublicationAuthority = {
  repositoryId?: string
  subjectPath: OwnedPath
  subjectRecord: string
  records: readonly { path: OwnedPath; sha256: string }[]
  inventory: readonly ObjectRef[]
  /** Target-owned records to copy into CAS before a new manifest references them. */
  recordObjects: readonly { path: OwnedPath; object: ObjectRef }[]
}

export type RepositoryRecords = ContractRepositoryRecords

export type DecisionRecordAuthority = {
  canonicalBranch: string
  records: readonly { path: OwnedPath; sha256: Sha256 }[]
}

export type ConfigChange = Partial<
  Pick<RepositoryConfig, 'canonicalBranch' | 'reviewer' | 'automaticReview' | 'reviewLimits'>
>

export type VerificationIssue = {
  code:
    | 'unsafe-symbolic-link'
    | 'invalid-structured-record'
    | 'object-name-invalid'
    | 'object-digest-mismatch'
    | 'object-oversized'
    | 'referenced-object-missing'
    | 'referenced-object-size-mismatch'
  path: string
  detail: string
}

export type RepositoryVerification = {
  repositoryId: string
  recordsChecked: number
  objectsChecked: number
  issues: readonly VerificationIssue[]
}

export class ImmutableRecordConflictError extends Error {
  constructor(readonly path: OwnedPath) {
    super(`immutable Factory record already exists with different bytes: ${path}`)
    this.name = 'ImmutableRecordConflictError'
  }
}

export class DecisionAuthorityConflictError extends Error {
  constructor(readonly path: OwnedPath) {
    super(`decision authority changed before append: ${path}`)
    this.name = 'DecisionAuthorityConflictError'
  }
}

export class UnsupportedRepositoryLayoutError extends Error {
  constructor() {
    super('Factory v1 requires the Git common directory and worktree to share one filesystem')
    this.name = 'UnsupportedRepositoryLayoutError'
  }
}

export type RepositoryStoreOptions = {
  maxObjectBytes?: number
  /** Override for tests; production stages under the Git common directory. */
  runtimeRoot?: string
  /** Shortens lock-contention tests without weakening the production default. */
  mutationLockTimeoutMs?: number
}

const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024
const OWNED_DIRECTORIES = [
  'sessions',
  'repository-observations',
  'pull-requests',
  'review-triggers',
  'reviews',
  'decisions',
  'objects',
] as const

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

async function pathKind(
  path: string,
): Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'> {
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) return 'symlink'
    if (entry.isFile()) return 'file'
    if (entry.isDirectory()) return 'directory'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

async function requireOrdinaryFile(path: string): Promise<void> {
  const kind = await pathKind(path)
  if (kind === 'symlink') throw new Error(`Factory refuses symbolic link: ${path}`)
  if (kind !== 'file') throw new Error(`Factory requires an ordinary file: ${path}`)
}

async function readBoundedOrdinary(path: string, maximumBytes: number): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`Factory requires an ordinary file: ${path}`)
    if (before.size > BigInt(maximumBytes))
      throw new Error(`Factory file exceeds read bound: ${path}`)
    const bytes = new Uint8Array(Number(before.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (
      offset !== bytes.byteLength ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`Factory file changed while reading: ${path}`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function readManifest(path: string): Promise<RepositoryManifest> {
  await requireOrdinaryFile(path)
  const text = decodeUtf8(await readFile(path))
  const manifest = parseRepositoryManifest(JSON.parse(text))
  if (canonicalJson(manifest) !== text) throw new TypeError('manifest is not canonical JSON')
  return manifest
}

async function ensureDirectory(path: string): Promise<void> {
  const kind = await pathKind(path)
  if (kind === 'symlink') throw new Error(`Factory refuses symbolic link: ${path}`)
  if (kind === 'missing') {
    try {
      await mkdir(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await pathKind(path)) !== 'directory') {
        throw new Error(`Factory requires a directory: ${path}`)
      }
    }
    return
  }
  if (kind !== 'directory') throw new Error(`Factory requires a directory: ${path}`)
}

async function ensureStagingRoot(path: string): Promise<void> {
  const missing: string[] = []
  let current = path
  while ((await pathKind(current)) === 'missing') {
    missing.push(basename(current))
    const parent = dirname(current)
    if (parent === current) throw new Error(`Factory cannot resolve staging root: ${path}`)
    current = parent
  }
  if ((await pathKind(current)) !== 'directory') {
    throw new Error(`Factory requires a directory: ${current}`)
  }
  for (const segment of missing.reverse()) {
    current = join(current, segment)
    await ensureDirectory(current)
  }
}

async function ensureOwnedParent(factoryRoot: string, path: OwnedPath): Promise<string> {
  await ensureDirectory(factoryRoot)
  const parts = path.split('/')
  let current = factoryRoot
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    await ensureDirectory(current)
  }
  return join(factoryRoot, path)
}

function validateStructuredRecord(path: OwnedPath, bytes: Uint8Array): void {
  const text = decodeUtf8(bytes)
  if (path.endsWith('.json')) {
    const value = JSON.parse(text) as JsonValue
    if (canonicalJson(value) !== text) throw new TypeError(`${path} is not canonical JSON`)
    validatePublicRecord(path, value)
    return
  }
  if (path.endsWith('.jsonl')) {
    if (text.length === 0) return
    if (!text.endsWith('\n')) throw new TypeError(`${path} must end with a newline`)
    for (const line of text.slice(0, -1).split('\n')) {
      if (line.length === 0) throw new TypeError(`${path} contains an empty JSONL record`)
      const value = JSON.parse(line) as JsonValue
      if (canonicalJson(value) !== `${line}\n`) {
        throw new TypeError(`${path} contains a non-canonical JSONL record`)
      }
      validatePublicRecord(path, value)
    }
    return
  }
  validatePublicRecord(path, text)
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicCreate(
  path: string,
  ownedPath: OwnedPath,
  bytes: Uint8Array,
  stagingRoot: string,
): Promise<void> {
  await ensureStagingRoot(stagingRoot)
  const temporary = join(stagingRoot, `create-${randomUUID()}`)
  await writeFile(temporary, bytes, { flag: 'wx' })
  await syncFile(temporary)
  try {
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        throw new UnsupportedRepositoryLayoutError()
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await pathKind(path)) === 'symlink') {
        throw new Error(`Factory refuses symbolic link: ${path}`)
      }
      const existing = await readFile(path)
      if (!existing.equals(bytes)) throw new ImmutableRecordConflictError(ownedPath)
    }
    await syncDirectory(dirname(path))
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function atomicReplace(path: string, bytes: Uint8Array, stagingRoot: string): Promise<void> {
  if ((await pathKind(path)) === 'symlink')
    throw new Error(`Factory refuses symbolic link: ${path}`)
  await ensureStagingRoot(stagingRoot)
  const temporary = join(stagingRoot, `replace-${randomUUID()}`)
  await writeFile(temporary, bytes, { flag: 'wx' })
  await syncFile(temporary)
  try {
    try {
      await rename(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        throw new UnsupportedRepositoryLayoutError()
      }
      throw error
    }
    await syncDirectory(dirname(path))
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function resolveRuntimeRoot(repositoryRoot: string, configured?: string): Promise<string> {
  const resolvedRepositoryRoot = await realpath(repositoryRoot)
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new TypeError('runtimeRoot must be absolute')
    const runtimeRoot = await realpath(configured)
    if ((await pathKind(runtimeRoot)) !== 'directory') {
      throw new TypeError('runtimeRoot must name an existing directory')
    }
    if ((await stat(runtimeRoot)).dev !== (await stat(resolvedRepositoryRoot)).dev) {
      throw new UnsupportedRepositoryLayoutError()
    }
    return runtimeRoot
  }
  const dotGit = join(repositoryRoot, '.git')
  const gitKind = await pathKind(dotGit)
  let gitDirectory: string
  if (gitKind === 'directory') {
    gitDirectory = await realpath(dotGit)
  } else if (gitKind === 'file') {
    const marker = decodeUtf8(await readFile(dotGit)).trim()
    const match = /^gitdir: (.+)$/.exec(marker)
    if (match?.[1] === undefined) throw new Error('invalid linked-worktree .git file')
    gitDirectory = await realpath(resolve(repositoryRoot, match[1]))
  } else {
    throw new Error('Factory repository writer requires Git metadata or an explicit runtimeRoot')
  }
  const commonMarker = join(gitDirectory, 'commondir')
  const commonDirectory =
    (await pathKind(commonMarker)) === 'file'
      ? await realpath(resolve(gitDirectory, decodeUtf8(await readFile(commonMarker)).trim()))
      : gitDirectory
  if ((await stat(commonDirectory)).dev !== (await stat(resolvedRepositoryRoot)).dev) {
    throw new UnsupportedRepositoryLayoutError()
  }
  const worktreeKey = sha256(new TextEncoder().encode(gitDirectory)).slice(0, 24)
  return join(commonDirectory, 'factory-runtime', 'worktrees', worktreeKey, 'repository-staging')
}

function collectObjectRefs(value: unknown, refs: ObjectRef[]): void {
  if (Array.isArray(value)) {
    value.forEach(entry => collectObjectRefs(entry, refs))
    return
  }
  if (value === null || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (
    record.algorithm === 'sha256' &&
    typeof record.sha256 === 'string' &&
    typeof record.bytes === 'number' &&
    typeof record.mediaType === 'string' &&
    typeof record.role === 'string'
  ) {
    refs.push(record as ObjectRef)
  }
  Object.entries(record).forEach(([key, entry]) => {
    if (key !== 'parsed' && key !== 'subject' && key !== 'assertion') collectObjectRefs(entry, refs)
  })
}

async function inspectObject(
  path: string,
  maximumBytes: number,
): Promise<{ bytes: number; digest?: string; oversized: boolean }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.byteLength
    if (bytes > maximumBytes) return { bytes, oversized: true }
    hash.update(chunk)
  }
  return { bytes, digest: hash.digest('hex'), oversized: false }
}

export class RepositoryStore {
  readonly factoryRoot: string
  readonly maxObjectBytes: number
  readonly stagingRoot: string
  private readonly mutationLockTimeoutMs: number
  private readonly configuredRuntimeRoot?: string

  private constructor(
    readonly repositoryRoot: string,
    readonly manifest: RepositoryManifest,
    stagingRoot: string,
    options: RepositoryStoreOptions,
  ) {
    this.factoryRoot = join(repositoryRoot, '.factory')
    this.maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES
    this.stagingRoot = stagingRoot
    this.mutationLockTimeoutMs = options.mutationLockTimeoutMs ?? 5_000
    this.configuredRuntimeRoot = options.runtimeRoot
  }

  static async open(
    repositoryRoot: string,
    options: RepositoryStoreOptions = {},
  ): Promise<RepositoryStore> {
    const factoryRoot = join(repositoryRoot, '.factory')
    if ((await pathKind(factoryRoot)) === 'symlink') {
      throw new Error(`Factory refuses symbolic link: ${factoryRoot}`)
    }
    const manifestPath = join(factoryRoot, 'manifest.json')
    const manifest = await readManifest(manifestPath)
    const stagingRoot = await resolveRuntimeRoot(repositoryRoot, options.runtimeRoot)
    return new RepositoryStore(repositoryRoot, manifest, stagingRoot, options)
  }

  private async assertCurrentManifest(): Promise<void> {
    const current = await readManifest(join(this.factoryRoot, 'manifest.json'))
    if (canonicalJson(current) !== canonicalJson(this.manifest)) {
      throw new ImmutableRecordConflictError(makeOwnedPath('manifest'))
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    await ensureStagingRoot(this.stagingRoot)
    return await withAdvisoryFileLock(
      join(this.stagingRoot, 'repository.lock'),
      this.mutationLockTimeoutMs,
      async () => {
        await this.assertCurrentManifest()
        return await operation()
      },
    )
  }

  async putObject(
    source: AsyncIterable<Uint8Array>,
    metadata: { mediaType?: string; role?: string } = {},
  ): Promise<ObjectRef> {
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of source) {
      bytes += chunk.byteLength
      if (bytes > this.maxObjectBytes) {
        throw new Error(`Factory object exceeds maximum of ${this.maxObjectBytes} bytes`)
      }
      chunks.push(chunk.slice())
    }
    const content = Buffer.concat(chunks)
    const hash = sha256(content)
    const path = objectOwnedPath(hash)
    await this.withMutationLock(async () => {
      const destination = await ensureOwnedParent(this.factoryRoot, path)
      await atomicCreate(destination, path, content, this.stagingRoot)
    })
    return {
      algorithm: 'sha256',
      sha256: hash,
      bytes,
      mediaType: metadata.mediaType ?? 'application/octet-stream',
      role: metadata.role ?? 'raw',
    }
  }

  /** Read exact CAS bytes only after verifying their public reference. */
  async getObject(ref: ObjectRef): Promise<Uint8Array> {
    validateObjectRef(ref)
    if (ref.bytes > this.maxObjectBytes) throw new Error('Factory object exceeds configured limit')
    const path = join(this.factoryRoot, objectOwnedPath(ref.sha256))
    const bytes = await readBoundedOrdinary(path, Math.min(this.maxObjectBytes, ref.bytes))
    if (bytes.byteLength !== ref.bytes || sha256(bytes) !== ref.sha256) {
      throw new Error(`Factory object failed verification: ${ref.sha256}`)
    }
    return bytes
  }

  /** Verify and return one immutable record; used as journal completion proof. */
  async readImmutable(path: OwnedPath, expectedSha256?: string): Promise<Uint8Array> {
    assertOwnedRecordPath(path)
    if (path === makeOwnedPath('config')) throw new TypeError('config is mutable')
    const absolute = join(this.factoryRoot, path)
    const bytes = await readBoundedOrdinary(absolute, 4 * 1024 * 1024)
    validateStructuredRecord(path, bytes)
    if (expectedSha256 !== undefined && sha256(bytes) !== expectedSha256) {
      throw new Error(`Factory immutable record failed verification: ${path}`)
    }
    return bytes
  }

  async tryReadImmutable(path: OwnedPath): Promise<Uint8Array | undefined> {
    try {
      return await this.readImmutable(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * Publish a deterministic immutable graph with its logical commit record last.
   * Interrupted prefixes remain invisible to repository projections and converge
   * on recovery because every path is create-only with exact-byte comparison.
   */
  async publishImmutableGroup(
    records: readonly ImmutableGroupRecord[],
    commitPath: OwnedPath,
  ): Promise<RecordRef> {
    const snapshots = records.map(record => ({ path: record.path, bytes: record.bytes.slice() }))
    if (snapshots.length === 0) throw new TypeError('immutable group must not be empty')
    const triggerCommit = /^review-triggers\/[^/]+\.json$/.test(commitPath)
    const reviewCommit =
      /^reviews\/workspace\/[^/]+\/manifest\.json$/.test(commitPath) ||
      /^reviews\/pull-requests\/github\/[^/]+\/[1-9]\d*\/[^/]+\/manifest\.json$/.test(commitPath)
    if (!triggerCommit && !reviewCommit) {
      throw new TypeError('immutable group commit point must be a trigger or review manifest')
    }
    const paths = new Set<string>()
    for (const record of snapshots) {
      if (record.bytes.byteLength > 4 * 1024 * 1024)
        throw new TypeError('immutable structured record exceeds its read bound')
      if (record.path === makeOwnedPath('manifest') || record.path === makeOwnedPath('config')) {
        throw new TypeError('manifest and config cannot belong to an immutable group')
      }
      if (record.path.startsWith('objects/')) throw new TypeError('objects use putObject')
      if (paths.has(record.path))
        throw new TypeError(`duplicate immutable group path: ${record.path}`)
      paths.add(record.path)
      validateStructuredRecord(record.path, record.bytes)
    }
    if (!paths.has(commitPath)) throw new TypeError('immutable group commit path is absent')
    if (reviewCommit) {
      const root = `${dirname(commitPath)}/`
      const manifest = snapshots.find(record => record.path === commitPath)!
      const value = JSON.parse(decodeUtf8(manifest.bytes)) as { disposition: string }
      const responsePath = `${root}response.txt`
      const ledgerPath = `${root}ledger.json`
      const expectedPaths =
        value.disposition === 'failed'
          ? [commitPath, responsePath]
          : [commitPath, responsePath, ledgerPath]
      if (
        snapshots.some(record => !record.path.startsWith(root)) ||
        canonicalJson([...paths].sort()) !== canonicalJson(expectedPaths.sort())
      ) {
        throw new TypeError(
          'review group must contain only its exact manifest, response, and ledger',
        )
      }
    }
    const ordered = [
      ...snapshots.filter(record => record.path !== commitPath),
      snapshots.find(record => record.path === commitPath)!,
    ]
    await this.withMutationLock(async () => {
      for (const record of ordered) {
        const destination = await ensureOwnedParent(this.factoryRoot, record.path)
        await atomicCreate(destination, record.path, record.bytes, this.stagingRoot)
      }
    })
    const commit = ordered.at(-1)!
    return { path: commit.path, sha256: sha256(commit.bytes), bytes: commit.bytes.byteLength }
  }

  /** Verify a bundle's repository authority and publish its review under one mutation lock. */
  async publishReview(
    authority: ReviewPublicationAuthority,
    records: readonly ImmutableGroupRecord[],
    commitPath: OwnedPath,
  ): Promise<RecordRef> {
    const snapshots = records.map(record => ({ path: record.path, bytes: record.bytes.slice() }))
    const reviewCommit =
      /^reviews\/workspace\/[^/]+\/manifest\.json$/.test(commitPath) ||
      /^reviews\/pull-requests\/github\/[^/]+\/[1-9]\d*\/[^/]+\/manifest\.json$/.test(commitPath)
    if (!reviewCommit) throw new TypeError('review publication requires a review manifest')
    const root = `${dirname(commitPath)}/`
    const paths = new Set<string>()
    for (const record of snapshots) {
      if (record.bytes.byteLength > 4 * 1024 * 1024)
        throw new TypeError('immutable structured record exceeds its read bound')
      if (!record.path.startsWith(root) || paths.has(record.path))
        throw new TypeError('review publication contains an invalid path set')
      paths.add(record.path)
      validateStructuredRecord(record.path, record.bytes)
    }
    const manifest = snapshots.find(record => record.path === commitPath)
    if (manifest === undefined) throw new TypeError('review publication manifest is absent')
    const disposition = (JSON.parse(decodeUtf8(manifest.bytes)) as { disposition: string })
      .disposition
    const expected =
      disposition === 'failed'
        ? [commitPath, `${root}response.txt`]
        : [commitPath, `${root}response.txt`, `${root}ledger.json`]
    if (canonicalJson([...paths].sort()) !== canonicalJson(expected.sort()))
      throw new TypeError('review publication has the wrong manifest/response/ledger shape')
    const ordered = [...snapshots.filter(record => record.path !== commitPath), manifest]
    const authorityRecords = new Map(authority.records.map(record => [record.path, record]))
    const importedPaths = new Set<string>()
    for (const imported of authority.recordObjects) {
      validateObjectRef(imported.object)
      const record = authorityRecords.get(imported.path)
      if (
        record === undefined ||
        record.sha256 !== imported.object.sha256 ||
        importedPaths.has(imported.path)
      )
        throw new TypeError('review publication record object lacks exact record authority')
      importedPaths.add(imported.path)
    }
    await this.withMutationLock(async () => {
      if (
        authority.repositoryId !== undefined &&
        authority.repositoryId !== this.manifest.repositoryId
      )
        throw new TypeError('review bundle belongs to a different repository')
      for (const record of authority.records) await this.readImmutable(record.path, record.sha256)
      const subjectBytes = await this.readImmutable(authority.subjectPath)
      if (decodeUtf8(subjectBytes) !== authority.subjectRecord)
        throw new TypeError('review subject differs from the target repository')
      for (const object of authority.inventory) await this.getObject(object)
      for (const imported of authority.recordObjects) {
        const bytes = await this.readImmutable(imported.path, imported.object.sha256)
        if (bytes.byteLength !== imported.object.bytes)
          throw new TypeError('review publication record object length differs from authority')
        const path = objectOwnedPath(imported.object.sha256)
        const destination = await ensureOwnedParent(this.factoryRoot, path)
        await atomicCreate(destination, path, bytes, this.stagingRoot)
      }
      for (const record of ordered) {
        const destination = await ensureOwnedParent(this.factoryRoot, record.path)
        await atomicCreate(destination, record.path, record.bytes, this.stagingRoot)
      }
    })
    return {
      path: manifest.path,
      sha256: sha256(manifest.bytes),
      bytes: manifest.bytes.byteLength,
    }
  }

  /** Rebuild input: validated owned records, with CAS bytes intentionally excluded. */
  async readRecords(): Promise<RepositoryRecords> {
    await this.assertCurrentManifest()
    const records: Array<{ path: OwnedPath; value: JsonValue | string }> = []
    let aggregateBytes = 0
    let recordCount = 0
    const visit = async (root: string, relativeRoot: string, depth: number): Promise<void> => {
      if (depth > 12) throw new Error('Factory record tree exceeds maximum depth')
      const entries = await readdir(root, { withFileTypes: true })
      entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
      for (const entry of entries) {
        const relative = relativeRoot.length === 0 ? entry.name : `${relativeRoot}/${entry.name}`
        const absolute = join(root, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`Factory refuses symbolic link: ${absolute}`)
        if (entry.isDirectory()) {
          if (!relative.startsWith('objects')) await visit(absolute, relative, depth + 1)
          continue
        }
        if (!entry.isFile() || relative === 'config.json' || relative === 'manifest.json') continue
        await requireOrdinaryFile(absolute)
        recordCount += 1
        if (recordCount > 100_000) throw new Error('Factory record tree exceeds record bound')
        const path = relative as OwnedPath
        const file = await stat(absolute)
        if (file.size > 4 * 1024 * 1024)
          throw new Error(`Factory record exceeds read bound: ${path}`)
        aggregateBytes += file.size
        if (aggregateBytes > 64 * 1024 * 1024)
          throw new Error('Factory record tree exceeds aggregate read bound')
        const bytes = await readBoundedOrdinary(absolute, 4 * 1024 * 1024)
        validateStructuredRecord(path, bytes)
        const text = decodeUtf8(bytes)
        if (path.endsWith('.json')) records.push({ path, value: JSON.parse(text) as JsonValue })
        else if (path.endsWith('.jsonl') && text.length > 0) {
          for (const line of text.trimEnd().split('\n')) {
            records.push({ path, value: JSON.parse(line) as JsonValue })
          }
        } else records.push({ path, value: text })
      }
    }
    for (const area of OWNED_DIRECTORIES.filter(area => area !== 'objects')) {
      const root = join(this.factoryRoot, area)
      if ((await pathKind(root)) === 'directory') await visit(root, area, 0)
    }
    return { config: await this.readConfig(), records }
  }

  async createImmutable(path: OwnedPath, bytes: Uint8Array): Promise<RecordRef> {
    if (path === makeOwnedPath('manifest') || path === makeOwnedPath('config')) {
      throw new TypeError('manifest and config use their dedicated repository operations')
    }
    if (path.startsWith('objects/')) {
      throw new TypeError('objects use putObject so their identity is derived from exact bytes')
    }
    if (bytes.byteLength > 4 * 1024 * 1024)
      throw new TypeError('immutable structured record exceeds its read bound')
    validateStructuredRecord(path, bytes)
    await this.withMutationLock(async () => {
      const destination = await ensureOwnedParent(this.factoryRoot, path)
      await atomicCreate(destination, path, bytes, this.stagingRoot)
    })
    return { path, sha256: sha256(bytes), bytes: bytes.byteLength }
  }

  /** Publish one semantic coverage acceptance; identical concurrent retries share its first time. */
  async createCoverageAction(
    semantic: Omit<CoverageAction, 'createdAt'>,
    now: () => Date = () => new Date(),
  ): Promise<RecordRef> {
    const path = makeOwnedPath('reviews', ['coverage-actions', `${semantic.actionId}.json`])
    return await this.withMutationLock(async () => {
      const destination = await ensureOwnedParent(this.factoryRoot, path)
      if ((await pathKind(destination)) === 'file') {
        const bytes = await readBoundedOrdinary(destination, 4 * 1024 * 1024)
        validateStructuredRecord(path, bytes)
        const existing = JSON.parse(decodeUtf8(bytes)) as CoverageAction
        const { createdAt: _createdAt, ...existingSemantic } = existing
        if (canonicalJson(existingSemantic) !== canonicalJson(semantic))
          throw new ImmutableRecordConflictError(path)
        return { path, sha256: sha256(bytes), bytes: bytes.byteLength }
      }
      const action: CoverageAction = {
        ...semantic,
        createdAt: now().toISOString(),
      }
      const bytes = new TextEncoder().encode(canonicalJson(action))
      validateStructuredRecord(path, bytes)
      await atomicCreate(destination, path, bytes, this.stagingRoot)
      return { path, sha256: sha256(bytes), bytes: bytes.byteLength }
    })
  }

  /** Append one validated action iff the exact decision records used for validation are current. */
  async createDecisionAction(
    action: DecisionAction,
    authority: DecisionRecordAuthority,
  ): Promise<RecordRef> {
    const path = makeOwnedPath('decisions', ['actions', `${action.actionId}.json`])
    return await this.withMutationLock(async () => {
      const destination = await ensureOwnedParent(this.factoryRoot, path)
      if ((await pathKind(destination)) === 'file') {
        const bytes = await readBoundedOrdinary(destination, 4 * 1024 * 1024)
        validateStructuredRecord(path, bytes)
        const existing = JSON.parse(decodeUtf8(bytes)) as DecisionAction
        const { createdAt: _existingAt, ...existingSemantic } = existing
        const { createdAt: _requestedAt, ...requestedSemantic } = action
        if (canonicalJson(existingSemantic) !== canonicalJson(requestedSemantic))
          throw new ImmutableRecordConflictError(path)
        return { path, sha256: sha256(bytes), bytes: bytes.byteLength }
      }
      const current = (await this.readRecords()).records
        .filter(record => record.path.startsWith('decisions/'))
        .map(record => ({
          path: record.path,
          sha256: sha256(new TextEncoder().encode(canonicalJson(record.value))),
        }))
        .sort((left, right) => left.path.localeCompare(right.path))
      const expected = [...authority.records].sort((left, right) =>
        left.path.localeCompare(right.path),
      )
      const config = await this.readConfig()
      if (
        config.canonicalBranch !== authority.canonicalBranch ||
        canonicalJson(current) !== canonicalJson(expected)
      )
        throw new DecisionAuthorityConflictError(path)
      const bytes = new TextEncoder().encode(canonicalJson(action))
      validateStructuredRecord(path, bytes)
      await atomicCreate(destination, path, bytes, this.stagingRoot)
      return { path, sha256: sha256(bytes), bytes: bytes.byteLength }
    })
  }

  async updateConfig(change: ConfigChange): Promise<void> {
    await this.withMutationLock(async () => {
      const configPath = join(this.factoryRoot, 'config.json')
      await requireOrdinaryFile(configPath)
      const existing = parseRepositoryConfig(JSON.parse(decodeUtf8(await readFile(configPath))))
      const updated = parseRepositoryConfig({ ...existing, ...change })
      await atomicReplace(
        configPath,
        new TextEncoder().encode(canonicalJson(updated)),
        this.stagingRoot,
      )
    })
  }

  async readConfig(): Promise<RepositoryConfig> {
    const configPath = join(this.factoryRoot, 'config.json')
    await requireOrdinaryFile(configPath)
    return parseRepositoryConfig(JSON.parse(decodeUtf8(await readFile(configPath))))
  }

  /** Copy a selected, verified CAS inventory into a disposable bundle tree. */
  async materializeObjectInventory(
    refs: readonly ObjectRef[],
    destinationRoot: string,
  ): Promise<void> {
    await this.assertCurrentManifest()
    for (const ref of refs) {
      validateObjectRef(ref)
      const relativePath = objectOwnedPath(ref.sha256)
      const source = join(this.factoryRoot, relativePath)
      await requireOrdinaryFile(source)
      const sourceInspection = await inspectObject(source, this.maxObjectBytes)
      if (
        sourceInspection.oversized ||
        sourceInspection.bytes !== ref.bytes ||
        sourceInspection.digest !== ref.sha256
      ) {
        throw new Error(`Factory object failed verification: ${ref.sha256}`)
      }
      const destination = await ensureOwnedParent(destinationRoot, relativePath)
      const temporary = join(dirname(destination), `.factory-materialize-${randomUUID()}`)
      try {
        await pipeline(createReadStream(source), createWriteStream(temporary, { flags: 'wx' }))
        const temporaryInspection = await inspectObject(temporary, this.maxObjectBytes)
        if (
          temporaryInspection.oversized ||
          temporaryInspection.bytes !== ref.bytes ||
          temporaryInspection.digest !== ref.sha256
        ) {
          throw new Error(`Materialized Factory object failed verification: ${ref.sha256}`)
        }
        try {
          await link(temporary, destination)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          await requireOrdinaryFile(destination)
        }
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
      const destinationInspection = await inspectObject(destination, this.maxObjectBytes)
      if (
        destinationInspection.oversized ||
        destinationInspection.bytes !== ref.bytes ||
        destinationInspection.digest !== ref.sha256
      ) {
        throw new Error(`Materialized Factory object failed verification: ${ref.sha256}`)
      }
    }
  }

  async verify(): Promise<RepositoryVerification> {
    const reopened = await RepositoryStore.open(this.repositoryRoot, {
      maxObjectBytes: this.maxObjectBytes,
      runtimeRoot: this.configuredRuntimeRoot,
    })
    const issues: VerificationIssue[] = []
    const refs: ObjectRef[] = []
    let recordsChecked = 1
    let objectsChecked = 0

    const inspectTree = async (root: string, relativeRoot: string): Promise<void> => {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const relativePath =
          relativeRoot.length === 0 ? entry.name : `${relativeRoot}/${entry.name}`
        const fullPath = join(root, entry.name)
        if (entry.isSymbolicLink()) {
          issues.push({
            code: 'unsafe-symbolic-link',
            path: relativePath,
            detail: 'owned Factory trees may not contain symbolic links',
          })
          continue
        }
        if (entry.isDirectory()) {
          await inspectTree(fullPath, relativePath)
          continue
        }
        if (!entry.isFile()) continue
        if (relativePath.startsWith('objects/')) {
          objectsChecked += 1
          const match = /^objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{62})$/.exec(relativePath)
          if (match === null) {
            issues.push({
              code: 'object-name-invalid',
              path: relativePath,
              detail: 'object path does not encode lowercase SHA-256',
            })
            continue
          }
          const expectedHash = `${match[1]}${match[2]}`
          const inspected = await inspectObject(fullPath, reopened.maxObjectBytes)
          if (inspected.oversized) {
            issues.push({
              code: 'object-oversized',
              path: relativePath,
              detail: `object exceeds ${reopened.maxObjectBytes} bytes`,
            })
          } else if (inspected.digest !== expectedHash) {
            issues.push({
              code: 'object-digest-mismatch',
              path: relativePath,
              detail: 'object bytes do not match path digest',
            })
          }
          continue
        }
        recordsChecked += 1
        try {
          const content = await readFile(fullPath)
          validateStructuredRecord(relativePath as OwnedPath, content)
          if (relativePath.endsWith('.json')) {
            collectObjectRefs(JSON.parse(decodeUtf8(content)), refs)
          } else if (relativePath.endsWith('.jsonl') && content.byteLength > 0) {
            for (const line of decodeUtf8(content).trimEnd().split('\n')) {
              collectObjectRefs(JSON.parse(line), refs)
            }
          }
        } catch (error) {
          issues.push({
            code: 'invalid-structured-record',
            path: relativePath,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    const configPath = join(this.factoryRoot, 'config.json')
    if ((await pathKind(configPath)) === 'file') {
      recordsChecked += 1
      try {
        const bytes = await readFile(configPath)
        const config = parseRepositoryConfig(JSON.parse(decodeUtf8(bytes)))
        if (canonicalJson(config) !== decodeUtf8(bytes))
          throw new Error('config is not canonical JSON')
        assertNoMachinePaths(config)
      } catch (error) {
        issues.push({
          code: 'invalid-structured-record',
          path: 'config.json',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    for (const area of OWNED_DIRECTORIES) {
      const root = join(this.factoryRoot, area)
      const kind = await pathKind(root)
      if (kind === 'symlink') {
        issues.push({
          code: 'unsafe-symbolic-link',
          path: area,
          detail: 'owned Factory trees may not be symbolic links',
        })
      } else if (kind === 'directory') {
        await inspectTree(root, area)
      }
    }

    for (const ref of refs) {
      const relativePath = objectOwnedPath(ref.sha256)
      const fullPath = join(this.factoryRoot, relativePath)
      if ((await pathKind(fullPath)) !== 'file') {
        issues.push({
          code: 'referenced-object-missing',
          path: relativePath,
          detail: `referenced ${ref.role} object is missing`,
        })
      } else if ((await lstat(fullPath)).size !== ref.bytes) {
        issues.push({
          code: 'referenced-object-size-mismatch',
          path: relativePath,
          detail: `referenced ${ref.role} object length differs from manifest`,
        })
      }
    }

    return {
      repositoryId: reopened.manifest.repositoryId,
      recordsChecked,
      objectsChecked,
      issues,
    }
  }
}

export async function openRepositoryStore(
  repositoryRoot: string,
  options: RepositoryStoreOptions = {},
): Promise<RepositoryStore> {
  return await RepositoryStore.open(repositoryRoot, options)
}

export async function initializeRepositoryStore(
  repositoryRoot: string,
  manifest: RepositoryManifest,
  config: RepositoryConfig,
  options: RepositoryStoreOptions = {},
): Promise<RepositoryStore> {
  parseRepositoryManifest(manifest)
  parseRepositoryConfig(config)
  assertNoMachinePaths(config)
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest))
  const configBytes = new TextEncoder().encode(canonicalJson(config))
  const factoryRoot = join(repositoryRoot, '.factory')
  if ((await pathKind(factoryRoot)) === 'missing') {
    await resolveRuntimeRoot(repositoryRoot, options.runtimeRoot)
  }
  await ensureDirectory(factoryRoot)
  const manifestPath = makeOwnedPath('manifest')
  const manifestDestination = join(factoryRoot, manifestPath)
  let store: RepositoryStore
  if ((await pathKind(manifestDestination)) === 'missing') {
    const stagingRoot = await resolveRuntimeRoot(repositoryRoot, options.runtimeRoot)
    await atomicCreate(manifestDestination, manifestPath, manifestBytes, stagingRoot)
    store = await RepositoryStore.open(repositoryRoot, options)
  } else {
    store = await RepositoryStore.open(repositoryRoot, options)
    if (canonicalJson(store.manifest) !== canonicalJson(manifest)) {
      throw new ImmutableRecordConflictError(manifestPath)
    }
  }
  const configPath = makeOwnedPath('config')
  const configDestination = join(factoryRoot, configPath)
  if ((await pathKind(configDestination)) === 'missing') {
    await atomicCreate(configDestination, configPath, configBytes, store.stagingRoot)
  } else {
    await requireOrdinaryFile(configDestination)
    const existingConfig = decodeUtf8(await readFile(configDestination))
    const parsedConfig = parseRepositoryConfig(JSON.parse(existingConfig))
    if (canonicalJson(parsedConfig) !== existingConfig) {
      throw new TypeError('config is not canonical JSON')
    }
  }
  return store
}
