import { createHash } from 'node:crypto'
import { constants, fstatSync, readSync, type BigIntStats } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

export class ReconstructionUnavailableError extends Error {
  readonly code = 'reconstruction-unavailable'

  constructor(detail: string, options?: ErrorOptions) {
    super(detail, options)
    this.name = 'ReconstructionUnavailableError'
  }
}

async function createBackend() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`unsupported reconstruction platform: ${process.platform}`)
  }
  const ffi = await import('bun:ffi')
  const library = ffi.dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    {
      openat: { args: ['i32', 'ptr', 'i32', 'i32'], returns: 'i32' },
      mkdirat: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
      write: { args: ['i32', 'ptr', 'usize'], returns: 'i64' },
      fchmod: { args: ['i32', 'i32'], returns: 'i32' },
      symlinkat: { args: ['ptr', 'i32', 'ptr'], returns: 'i32' },
      readlinkat: { args: ['i32', 'ptr', 'ptr', 'usize'], returns: 'i64' },
      close: { args: ['i32'], returns: 'i32' },
      flock: { args: ['i32', 'i32'], returns: 'i32' },
    },
  )
  const directoryReadName = process.platform === 'darwin' ? '__getdirentries64' : 'getdirentries64'
  const directoryLibrary = ffi.dlopen(
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    { [directoryReadName]: { args: ['i32', 'ptr', 'usize', 'ptr'], returns: 'i64' } },
  )
  return {
    library,
    ptr: ffi.ptr,
    readDirectory: directoryLibrary.symbols[directoryReadName]!,
  }
}

type NativeBackend = Awaited<ReturnType<typeof createBackend>>
let backendPromise: Promise<NativeBackend> | undefined

async function loadBackend(): Promise<NativeBackend> {
  try {
    return await (backendPromise ??= createBackend())
  } catch (cause) {
    backendPromise = undefined
    throw new ReconstructionUnavailableError(
      'snapshot reconstruction requires Bun with supported macOS libSystem or glibc-compatible Linux libc',
      { cause },
    )
  }
}

/** OS-released exclusive lock: process death closes the descriptor and releases ownership. */
export async function withAdvisoryFileLock<T>(
  path: string,
  timeoutMs: number,
  operation: () => Promise<T>,
  onUnavailable?: () => T,
): Promise<T> {
  const backend = await loadBackend()
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  )
  const deadline = Date.now() + timeoutMs
  try {
    const state = await handle.stat()
    if (!state.isFile()) throw new Error('advisory lock is not an ordinary file')
    await handle.chmod(0o600)
    while (backend.library.symbols.flock(handle.fd, 2 | 4) !== 0) {
      if (Date.now() >= deadline) {
        if (onUnavailable !== undefined) return onUnavailable()
        throw new Error('advisory file lock is unavailable')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    try {
      return await operation()
    } finally {
      backend.library.symbols.flock(handle.fd, 8)
    }
  } finally {
    await handle.close()
  }
}

function cString(bytes: Uint8Array): Buffer {
  if (bytes.includes(0)) throw new Error('confined path contains NUL')
  return Buffer.concat([Buffer.from(bytes), Buffer.from([0])])
}

function confinedSegment(bytes: Uint8Array): Buffer {
  const segment = Buffer.from(bytes)
  if (
    segment.byteLength === 0 ||
    segment.includes(47) ||
    segment.equals(Buffer.from('.')) ||
    segment.equals(Buffer.from('..'))
  ) {
    throw new Error('confined path contains an unsafe segment')
  }
  return cString(segment)
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

function clonePath(path: readonly Uint8Array[]): Buffer[] {
  return path.map(segment => Buffer.from(segment))
}

function pathKey(path: readonly Uint8Array[]): string {
  return Buffer.concat(
    path.flatMap((segment, index) =>
      index === 0 ? [Buffer.from(segment)] : [Buffer.from('/'), Buffer.from(segment)],
    ),
  ).toString('base64')
}

type NativeIdentity = {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  kind: 'directory' | 'file' | 'symlink' | 'special'
}

function descriptorIdentity(descriptor: number): NativeIdentity {
  const stats = fstatSync(descriptor, { bigint: true })
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    kind: stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : stats.isSymbolicLink()
          ? 'symlink'
          : 'special',
  }
}

function sameNativeIdentity(left: NativeIdentity, right: NativeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind
}

function sameNativeState(left: NativeIdentity, right: NativeIdentity): boolean {
  return (
    sameNativeIdentity(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

export type ConfinedReadOptions = {
  maximumBytes: number
  expectedRoot?: { dev: bigint; ino: bigint }
  /** Test seam after the leaf descriptor is bound. */
  afterOpen?: () => Promise<void>
}

/** Read through root-bound descriptors so pathname swaps cannot widen authority. */
export async function readConfinedFile(
  rootPath: string,
  path: readonly Uint8Array[],
  options: ConfinedReadOptions,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 0)
    throw new TypeError('maximumBytes must be a nonnegative safe integer')
  if (path.length === 0) throw new Error('confined path is empty')
  path.forEach(confinedSegment)
  const backend = await loadBackend()
  const root = await open(
    rootPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  const opened: number[] = []
  try {
    if (options.expectedRoot !== undefined) {
      const state = await root.stat({ bigint: true })
      if (state.dev !== options.expectedRoot.dev || state.ino !== options.expectedRoot.ino) {
        throw new Error('confined read root changed after inventory')
      }
    }
    let parent = root.fd
    for (const segment of path.slice(0, -1)) {
      const descriptor = backend.library.symbols.openat(
        parent,
        backend.ptr(confinedSegment(segment)),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        0,
      )
      if (descriptor < 0) throw new Error('cannot open confined read directory')
      opened.push(descriptor)
      parent = descriptor
    }
    const descriptor = backend.library.symbols.openat(
      parent,
      backend.ptr(confinedSegment(path.at(-1)!)),
      constants.O_RDONLY | constants.O_NOFOLLOW,
      0,
    )
    if (descriptor < 0) throw new Error('cannot open confined read file')
    opened.push(descriptor)
    const before = descriptorIdentity(descriptor)
    if (before.kind !== 'file') throw new Error('confined read target is not an ordinary file')
    if (before.size > BigInt(options.maximumBytes))
      throw new Error('confined read exceeds its size bound')
    await options.afterOpen?.()
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset)
      if (count === 0) throw new Error('confined read ended before the verified size')
      offset += count
    }
    if (!sameNativeState(before, descriptorIdentity(descriptor)))
      throw new Error('confined read target changed while reading')
    return bytes
  } finally {
    for (const descriptor of opened.reverse()) backend.library.symbols.close(descriptor)
    await root.close()
  }
}

type ConfinedWriterOptions = {
  /** Test seam for deterministic pathname replacement after an entry is open. */
  afterInventoryOpen?: (path: readonly Uint8Array[]) => Promise<void>
  /** Test seam for deterministic in-place mutation after a chunk is hashed. */
  afterInventoryChunk?: (path: readonly Uint8Array[]) => Promise<void>
}

/** Writes only relative to verified directory descriptors; path swaps cannot widen authority. */
export class ConfinedWriter {
  private readonly createdDirectories = new Map<
    string,
    { path: Buffer[]; identity: NativeIdentity }
  >()
  private readonly createdLeaves: Array<{
    path: Buffer[]
    identity: NativeIdentity
  }> = []

  private constructor(
    private readonly root: FileHandle,
    private readonly backend: NativeBackend,
    private readonly options: ConfinedWriterOptions,
  ) {}

  static async open(
    path: string,
    expected: BigIntStats,
    options: ConfinedWriterOptions = {},
  ): Promise<ConfinedWriter> {
    const backend = await loadBackend()
    const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const opened = await root.stat({ bigint: true })
      if (!opened.isDirectory() || !sameIdentity(expected, opened)) {
        throw new Error('reconstruction destination changed before confinement')
      }
      const writer = new ConfinedWriter(root, backend, options)
      await writer.assertEmpty()
      return writer
    } catch (error) {
      await root.close()
      throw error
    }
  }

  static async inspectTree(
    path: string,
    bounds: {
      maximumEntries: number
      maximumFileBytes: number
      maximumBytes: number
      maximumDepth?: number
      afterEntryOpen?: (path: readonly Uint8Array[]) => Promise<void>
      rootNames?: readonly string[]
      includeSnapshotToken?: boolean
    },
  ): Promise<readonly { kind: 'directory' | 'file' | 'symlink'; path: string }[]> {
    const backend = await loadBackend()
    const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const writer = new ConfinedWriter(root, backend, {
      afterInventoryOpen: bounds.afterEntryOpen,
    })
    try {
      const inventory = await writer.inventory(
        bounds.maximumEntries,
        bounds.maximumFileBytes,
        bounds.maximumBytes,
        bounds.maximumDepth,
        { bytes: 0 },
        writer.root.fd,
        [],
        [],
        bounds.rootNames === undefined ? undefined : new Set(bounds.rootNames),
      )
      return inventory.map(item => {
        const [kind, encodedPath] = item.split(':', 2)
        if (encodedPath === undefined) throw new Error('confined inventory entry is malformed')
        const entry: { kind: 'directory' | 'file' | 'symlink'; path: string } = {
          kind: kind === 'd' ? 'directory' : kind === 'f' ? 'file' : 'symlink',
          path: new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.from(encodedPath, 'base64'),
          ),
        }
        return bounds.includeSnapshotToken
          ? { ...entry, snapshotToken: item.slice(item.indexOf(':', 2) + 1) }
          : entry
      })
    } finally {
      await root.close()
    }
  }

  /** Discover selected ordinary files without consulting ignore rules or following links. */
  static async readFiles(
    rootPath: string,
    bounds: {
      maximumEntries: number
      maximumDepth: number
      maximumFiles: number
      maximumFileBytes: number
      maximumBytes: number
      includeFile: (name: string) => boolean
      skipDirectory: (name: string) => boolean
      skipNestedRepositories?: boolean
      afterEntryOpen?: (path: readonly Uint8Array[]) => Promise<void>
    },
  ): Promise<readonly Uint8Array[]> {
    for (const bound of [
      bounds.maximumEntries,
      bounds.maximumDepth,
      bounds.maximumFiles,
      bounds.maximumFileBytes,
      bounds.maximumBytes,
    ]) {
      if (!Number.isSafeInteger(bound) || bound < 0)
        throw new TypeError('confined file discovery bounds must be nonnegative safe integers')
    }
    try {
      const backend = await loadBackend()
      const root = await open(
        rootPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      const writer = new ConfinedWriter(root, backend, {})
      const files: Uint8Array[] = []
      const observed: { path: Buffer[]; identity: NativeIdentity; content?: Buffer }[] = []
      let entries = 0
      let bytes = 0
      // O_EVTONLY | O_SYMLINK on macOS; O_PATH | O_NOFOLLOW on Linux.
      // macOS still opens FIFOs with O_EVTONLY, so O_NONBLOCK is required there.
      const metadataFlags =
        process.platform === 'darwin'
          ? 0x8000 | 0x20_0000 | constants.O_NONBLOCK
          : 0x20_0000 | constants.O_NOFOLLOW
      const visit = async (descriptor: number, prefix: Buffer[]): Promise<void> => {
        const before = descriptorIdentity(descriptor)
        observed.push({ path: prefix, identity: before })
        const names = writer.directoryEntries(descriptor, bounds.maximumEntries - entries)
        entries += names.length
        for (const name of names) {
          const path = [...prefix, name]
          if (path.length > bounds.maximumDepth) throw new Error()
          const child = backend.library.symbols.openat(
            descriptor,
            backend.ptr(confinedSegment(name)),
            metadataFlags,
            0,
          )
          if (child < 0) throw new Error()
          try {
            const identity = descriptorIdentity(child)
            await bounds.afterEntryOpen?.(clonePath(path))
            // Replacement decoding supports ASCII basename policies on non-UTF-8 names;
            // filesystem operations keep the original bytes, never this display string.
            const label = name.toString('utf8')
            let included =
              identity.kind === 'directory'
                ? !bounds.skipDirectory(label)
                : identity.kind !== 'symlink' && bounds.includeFile(label)
            if (identity.kind === 'directory' && included && bounds.skipNestedRepositories) {
              const marker = backend.library.symbols.openat(
                child,
                backend.ptr(cString(Buffer.from('.git'))),
                metadataFlags,
                0,
              )
              if (marker >= 0) {
                backend.library.symbols.close(marker)
                included = false
              }
            }
            if (identity.kind === 'directory' && included) {
              const directory = writer.openExistingDirectory(descriptor, name)
              try {
                if (!sameNativeState(identity, descriptorIdentity(directory))) throw new Error()
                await visit(directory, path)
              } finally {
                backend.library.symbols.close(directory)
              }
            } else if (included) {
              if (
                identity.kind !== 'file' ||
                files.length >= bounds.maximumFiles ||
                identity.size > BigInt(bounds.maximumFileBytes) ||
                identity.size > BigInt(bounds.maximumBytes - bytes)
              )
                throw new Error()
              const file = backend.library.symbols.openat(
                descriptor,
                backend.ptr(confinedSegment(name)),
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                0,
              )
              if (file < 0) throw new Error()
              try {
                if (!sameNativeState(identity, descriptorIdentity(file))) throw new Error()
                const content = Buffer.alloc(Number(identity.size))
                let offset = 0
                while (offset < content.byteLength) {
                  const count = readSync(file, content, offset, content.byteLength - offset, offset)
                  if (count === 0) throw new Error()
                  offset += count
                }
                if (!sameNativeState(identity, descriptorIdentity(file))) throw new Error()
                files.push(content)
                observed.push({ path, identity, content })
                bytes += content.byteLength
              } finally {
                backend.library.symbols.close(file)
              }
            }
            const matches = included ? sameNativeState : sameNativeIdentity
            if (
              !matches(identity, descriptorIdentity(child)) ||
              !matches(identity, writer.currentIdentity(descriptor, name, metadataFlags))
            )
              throw new Error()
          } finally {
            backend.library.symbols.close(child)
          }
        }
        const finalNames = writer.directoryEntries(descriptor, names.length)
        if (
          !sameNativeState(before, descriptorIdentity(descriptor)) ||
          finalNames.length !== names.length ||
          finalNames.some((name, index) => !name.equals(names[index]!))
        )
          throw new Error()
      }
      try {
        await visit(root.fd, [])
        for (const { path, identity, content } of observed) {
          if (path.length === 0) {
            if (!sameNativeState(identity, descriptorIdentity(root.fd))) throw new Error()
            continue
          }
          const parent = await writer.parent(path, false)
          try {
            const descriptor = backend.library.symbols.openat(
              parent.descriptor,
              backend.ptr(parent.name),
              content === undefined
                ? metadataFlags
                : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              0,
            )
            if (descriptor < 0) throw new Error()
            try {
              if (!sameNativeState(identity, descriptorIdentity(descriptor))) throw new Error()
              if (content !== undefined) {
                // Coarse filesystem clocks can conceal a same-size overwrite in metadata.
                const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, content.byteLength))
                let offset = 0
                while (offset < content.byteLength) {
                  const count = readSync(
                    descriptor,
                    buffer,
                    0,
                    Math.min(buffer.byteLength, content.byteLength - offset),
                    offset,
                  )
                  if (
                    count === 0 ||
                    !buffer.subarray(0, count).equals(content.subarray(offset, offset + count))
                  )
                    throw new Error()
                  offset += count
                }
              }
              if (
                !sameNativeState(identity, descriptorIdentity(descriptor)) ||
                !sameNativeState(
                  identity,
                  writer.currentIdentity(parent.descriptor, path.at(-1)!, metadataFlags),
                )
              )
                throw new Error()
            } finally {
              backend.library.symbols.close(descriptor)
            }
          } finally {
            writer.closeParents(parent.opened)
          }
        }
        return files
      } finally {
        await root.close()
      }
    } catch {
      // Filesystem errors and caller callbacks can include paths or secret contents.
      throw new Error('confined file discovery failed')
    }
  }

  private openExistingDirectory(parent: number, segment: Uint8Array): number {
    const name = confinedSegment(segment)
    const descriptor = this.backend.library.symbols.openat(
      parent,
      this.backend.ptr(name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      0,
    )
    if (descriptor < 0) throw new Error('cannot open confined reconstruction directory')
    return descriptor
  }

  private async openDirectory(parent: number, path: readonly Uint8Array[]): Promise<number> {
    const key = pathKey(path)
    const name = confinedSegment(path.at(-1)!)
    if (!this.createdDirectories.has(key)) {
      if (this.backend.library.symbols.mkdirat(parent, this.backend.ptr(name), 0o755) !== 0) {
        throw new Error('cannot create confined reconstruction directory')
      }
      const descriptor = this.openExistingDirectory(parent, path.at(-1)!)
      try {
        this.createdDirectories.set(key, {
          path: clonePath(path),
          identity: descriptorIdentity(descriptor),
        })
        return descriptor
      } catch (error) {
        this.backend.library.symbols.close(descriptor)
        throw error
      }
    }
    return this.openExistingDirectory(parent, path.at(-1)!)
  }

  private async parent(
    path: readonly Uint8Array[],
    create: boolean,
  ): Promise<{ descriptor: number; name: Buffer; opened: number[] }> {
    if (path.length === 0) throw new Error('confined path is empty')
    path.forEach(confinedSegment)
    let descriptor = this.root.fd
    const opened: number[] = []
    const current: Uint8Array[] = []
    try {
      for (const segment of path.slice(0, -1)) {
        current.push(segment)
        descriptor = create
          ? await this.openDirectory(descriptor, current)
          : this.openExistingDirectory(descriptor, segment)
        opened.push(descriptor)
      }
      return { descriptor, name: confinedSegment(path.at(-1)!), opened }
    } catch (error) {
      for (const item of opened.reverse()) this.backend.library.symbols.close(item)
      throw error
    }
  }

  private closeParents(opened: number[]): void {
    for (const item of opened.reverse()) this.backend.library.symbols.close(item)
  }

  private currentIdentity(parent: number, name: Uint8Array, flags: number): NativeIdentity {
    const descriptor = this.backend.library.symbols.openat(
      parent,
      this.backend.ptr(cString(name)),
      flags,
      0,
    )
    if (descriptor < 0) throw new Error('reconstruction entry changed during inventory')
    try {
      return descriptorIdentity(descriptor)
    } finally {
      this.backend.library.symbols.close(descriptor)
    }
  }

  private directoryEntries(
    descriptor: number,
    maximumEntries: number,
    allowedNames?: ReadonlySet<string>,
  ): Buffer[] {
    const enumeration = this.backend.library.symbols.openat(
      descriptor,
      this.backend.ptr(cString(Buffer.from('.'))),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      0,
    )
    if (enumeration < 0) throw new Error('cannot open confined reconstruction inventory')
    const entries: Buffer[] = []
    const nameOffset = process.platform === 'darwin' ? 21 : 19
    const buffer = Buffer.alloc(64 * 1024)
    const position = Buffer.alloc(8)
    try {
      for (;;) {
        // EOF and failure travel in the native return value. libc errno cannot
        // safely carry that distinction across unrelated JavaScript/FFI work.
        const bytes = Number(
          this.backend.readDirectory(
            enumeration,
            this.backend.ptr(buffer),
            buffer.byteLength,
            this.backend.ptr(position),
          ),
        )
        if (bytes < 0) throw new Error('cannot read confined reconstruction directory')
        if (bytes === 0) break
        if (bytes > buffer.byteLength) throw new Error('invalid native directory batch')
        for (let offset = 0; offset < bytes; ) {
          if (bytes - offset < nameOffset + 1) throw new Error('invalid native directory entry')
          const recordBytes = buffer.readUInt16LE(offset + 16)
          if (recordBytes < nameOffset + 1 || recordBytes > bytes - offset)
            throw new Error('invalid native directory entry')
          const field = buffer.subarray(offset + nameOffset, offset + recordBytes)
          const end = field.indexOf(0)
          if (end < 0) throw new Error('invalid native directory entry')
          const name = Buffer.from(field.subarray(0, end))
          // Darwin readdir skips vacant inode slots; glibc returns them.
          const vacant = process.platform === 'darwin' && buffer.readBigUInt64LE(offset) === 0n
          offset += recordBytes
          if (vacant || name.equals(Buffer.from('.')) || name.equals(Buffer.from('..'))) continue
          if (allowedNames !== undefined && !allowedNames.has(name.toString('utf8'))) continue
          entries.push(name)
          if (entries.length > maximumEntries)
            throw new Error('reconstruction inventory exceeds the expected tree')
        }
      }
    } finally {
      this.backend.library.symbols.close(enumeration)
    }
    return entries.sort(Buffer.compare)
  }

  private async inventory(
    maximumEntries: number,
    maximumFileBytes: number,
    maximumBytes: number,
    maximumDepth = Number.MAX_SAFE_INTEGER,
    consumed = { bytes: 0 },
    descriptor = this.root.fd,
    prefix: Buffer[] = [],
    inventory: string[] = [],
    rootNames?: ReadonlySet<string>,
  ): Promise<string[]> {
    const directoryBefore = descriptorIdentity(descriptor)
    if (directoryBefore.kind !== 'directory')
      throw new Error('reconstruction entry changed during inventory')
    const entries = this.directoryEntries(
      descriptor,
      maximumEntries - inventory.length,
      prefix.length === 0 ? rootNames : undefined,
    )
    for (const name of entries) {
      const path = [...prefix, name]
      if (path.length > maximumDepth)
        throw new Error('reconstruction inventory exceeds directory depth bound')
      const child = this.backend.library.symbols.openat(
        descriptor,
        this.backend.ptr(cString(name)),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        0,
      )
      if (child < 0) {
        const target = Buffer.allocUnsafe(64 * 1024)
        const targetBytes = Number(
          this.backend.library.symbols.readlinkat(
            descriptor,
            this.backend.ptr(cString(name)),
            this.backend.ptr(target),
            target.byteLength,
          ),
        )
        if (targetBytes >= 0) {
          const symlinkDescriptor = this.backend.library.symbols.openat(
            descriptor,
            this.backend.ptr(cString(name)),
            process.platform === 'darwin' ? 0x20_0000 : 0x20_0000 | constants.O_NOFOLLOW,
            0,
          )
          if (symlinkDescriptor < 0) throw new Error('cannot inspect reconstruction symlink')
          try {
            await this.options.afterInventoryOpen?.(clonePath(path))
            const identity = descriptorIdentity(symlinkDescriptor)
            if (identity.kind !== 'symlink')
              throw new Error('reconstruction entry changed during inventory')
            const current = this.currentIdentity(
              descriptor,
              name,
              process.platform === 'darwin' ? 0x20_0000 : 0x20_0000 | constants.O_NOFOLLOW,
            )
            if (!sameNativeState(identity, current))
              throw new Error('reconstruction entry changed during inventory')
            const currentTarget = Buffer.allocUnsafe(64 * 1024)
            const currentTargetBytes = Number(
              this.backend.library.symbols.readlinkat(
                descriptor,
                this.backend.ptr(cString(name)),
                this.backend.ptr(currentTarget),
                currentTarget.byteLength,
              ),
            )
            if (
              currentTargetBytes !== targetBytes ||
              !currentTarget.subarray(0, currentTargetBytes).equals(target.subarray(0, targetBytes))
            ) {
              throw new Error('reconstruction entry changed during inventory')
            }
            consumed.bytes += targetBytes
            if (targetBytes > maximumFileBytes || consumed.bytes > maximumBytes) {
              throw new Error('reconstruction inventory exceeds the manifest byte limits')
            }
            const bytes = target.subarray(0, targetBytes)
            inventory.push(
              `s:${pathKey(path)}:${bytes.byteLength}:${createHash('sha256').update(bytes).digest('hex')}:${identity.dev}:${identity.ino}`,
            )
          } finally {
            this.backend.library.symbols.close(symlinkDescriptor)
          }
        } else {
          const fileDescriptor = this.backend.library.symbols.openat(
            descriptor,
            this.backend.ptr(cString(name)),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            0,
          )
          if (fileDescriptor < 0) throw new Error('cannot inspect reconstruction entry')
          try {
            await this.options.afterInventoryOpen?.(clonePath(path))
            const before = descriptorIdentity(fileDescriptor)
            if (before.kind !== 'file')
              throw new Error('reconstruction contains a special filesystem entry')
            if (
              before.size > BigInt(maximumFileBytes) ||
              before.size > BigInt(maximumBytes - consumed.bytes)
            ) {
              throw new Error('reconstruction inventory exceeds the manifest byte limits')
            }
            const digest = createHash('sha256')
            const buffer = Buffer.allocUnsafe(64 * 1024)
            let bytes = 0
            for (;;) {
              const read = readSync(fileDescriptor, buffer, 0, buffer.byteLength, bytes)
              if (read === 0) break
              bytes += read
              if (bytes > maximumFileBytes || bytes > maximumBytes - consumed.bytes) {
                throw new Error('reconstruction inventory exceeds the manifest byte limits')
              }
              digest.update(buffer.subarray(0, read))
              await this.options.afterInventoryChunk?.(clonePath(path))
            }
            const firstDigest = digest.digest('hex')
            const middle = descriptorIdentity(fileDescriptor)
            const middlePath = this.currentIdentity(
              descriptor,
              name,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            )
            if (!sameNativeState(before, middle) || !sameNativeState(middle, middlePath)) {
              throw new Error('reconstruction entry changed during inventory')
            }
            const verification = createHash('sha256')
            let verifiedBytes = 0
            for (;;) {
              const read = readSync(fileDescriptor, buffer, 0, buffer.byteLength, verifiedBytes)
              if (read === 0) break
              verifiedBytes += read
              if (
                verifiedBytes > maximumFileBytes ||
                verifiedBytes > maximumBytes - consumed.bytes
              ) {
                throw new Error('reconstruction inventory exceeds the manifest byte limits')
              }
              verification.update(buffer.subarray(0, read))
            }
            const finalDigest = verification.digest('hex')
            const after = descriptorIdentity(fileDescriptor)
            const current = this.currentIdentity(
              descriptor,
              name,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            )
            if (
              !sameNativeState(middle, after) ||
              !sameNativeState(after, current) ||
              firstDigest !== finalDigest ||
              bytes !== verifiedBytes ||
              BigInt(verifiedBytes) !== after.size
            ) {
              throw new Error('reconstruction entry changed during inventory')
            }
            consumed.bytes += verifiedBytes
            inventory.push(
              `f:${pathKey(path)}:${after.mode & 0o7777n}:${verifiedBytes}:${finalDigest}:${after.dev}:${after.ino}`,
            )
          } finally {
            this.backend.library.symbols.close(fileDescriptor)
          }
        }
        if (inventory.length > maximumEntries)
          throw new Error('reconstruction inventory exceeds the expected tree')
        continue
      }
      try {
        await this.options.afterInventoryOpen?.(clonePath(path))
        const identity = descriptorIdentity(child)
        if (identity.kind !== 'directory')
          throw new Error('reconstruction entry changed during inventory')
        inventory.push(`d:${pathKey(path)}:${identity.dev}:${identity.ino}`)
        if (inventory.length > maximumEntries)
          throw new Error('reconstruction inventory exceeds the expected tree')
        await this.inventory(
          maximumEntries,
          maximumFileBytes,
          maximumBytes,
          maximumDepth,
          consumed,
          child,
          path,
          inventory,
          undefined,
        )
        const after = descriptorIdentity(child)
        const current = this.currentIdentity(
          descriptor,
          name,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
        if (!sameNativeState(identity, after) || !sameNativeState(after, current)) {
          throw new Error('reconstruction entry changed during inventory')
        }
      } finally {
        this.backend.library.symbols.close(child)
      }
    }
    const directoryAfter = descriptorIdentity(descriptor)
    const finalEntries = this.directoryEntries(
      descriptor,
      entries.length,
      prefix.length === 0 ? rootNames : undefined,
    )
    if (
      !sameNativeState(directoryBefore, directoryAfter) ||
      finalEntries.length !== entries.length ||
      finalEntries.some((name, index) => !name.equals(entries[index]!))
    ) {
      throw new Error('reconstruction entry changed during inventory')
    }
    return inventory.sort()
  }

  async assertEmpty(): Promise<void> {
    if (this.directoryEntries(this.root.fd, 1).length !== 0) {
      throw new Error('reconstruction destination changed before writing')
    }
  }

  async assertExact(
    entries: readonly {
      path: readonly Uint8Array[]
      kind: 'file' | 'symlink'
      mode: 0o644 | 0o755
      bytes: number
      sha256: string
    }[],
  ): Promise<void> {
    const expected = new Set<string>()
    const createdLeaves = new Map(
      this.createdLeaves.map(created => [pathKey(created.path), created.identity]),
    )
    let maximumFileBytes = 0
    let maximumBytes = 0
    for (const { path, kind, mode, bytes, sha256 } of entries) {
      path.forEach(confinedSegment)
      for (let length = 1; length < path.length; length += 1) {
        const directoryKey = pathKey(path.slice(0, length))
        const identity = this.createdDirectories.get(directoryKey)?.identity
        if (identity === undefined)
          throw new Error('reconstruction directory identity is unavailable')
        expected.add(`d:${directoryKey}:${identity.dev}:${identity.ino}`)
      }
      const key = pathKey(path)
      const identity = createdLeaves.get(key)
      if (identity === undefined) throw new Error('reconstruction entry identity is unavailable')
      maximumFileBytes = Math.max(maximumFileBytes, bytes)
      maximumBytes += bytes
      expected.add(
        kind === 'symlink'
          ? `s:${key}:${bytes}:${sha256}:${identity.dev}:${identity.ino}`
          : `f:${key}:${mode}:${bytes}:${sha256}:${identity.dev}:${identity.ino}`,
      )
    }
    const wanted = [...expected].sort()
    const actual = await this.inventory(wanted.length + 1, maximumFileBytes, maximumBytes)
    if (actual.length !== wanted.length || actual.some((value, index) => value !== wanted[index])) {
      throw new Error(
        `reconstruction output does not exactly match the code manifest: ${JSON.stringify({ actual, wanted })}`,
      )
    }
  }

  async writeFile(
    path: readonly Uint8Array[],
    bytes: Uint8Array,
    mode: 0o644 | 0o755,
  ): Promise<void> {
    const content = Buffer.from(bytes)
    const parent = await this.parent(path, true)
    const descriptor = this.backend.library.symbols.openat(
      parent.descriptor,
      this.backend.ptr(parent.name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    )
    if (descriptor < 0) {
      this.closeParents(parent.opened)
      throw new Error('cannot create confined reconstruction file')
    }
    try {
      this.createdLeaves.push({
        path: clonePath(path),
        identity: descriptorIdentity(descriptor),
      })
      let offset = 0
      while (offset < content.byteLength) {
        const written = Number(
          this.backend.library.symbols.write(
            descriptor,
            this.backend.ptr(content, offset),
            content.byteLength - offset,
          ),
        )
        if (written <= 0) throw new Error('cannot write confined reconstruction file')
        offset += written
      }
      if (this.backend.library.symbols.fchmod(descriptor, mode) !== 0) {
        throw new Error('cannot set confined reconstruction mode')
      }
    } finally {
      this.backend.library.symbols.close(descriptor)
      this.closeParents(parent.opened)
    }
  }

  async symlink(path: readonly Uint8Array[], target: Uint8Array): Promise<void> {
    const targetBytes = Buffer.from(target)
    const targetString = cString(targetBytes)
    const parent = await this.parent(path, true)
    try {
      if (
        this.backend.library.symbols.symlinkat(
          this.backend.ptr(targetString),
          parent.descriptor,
          this.backend.ptr(parent.name),
        ) !== 0
      ) {
        throw new Error('cannot create confined reconstruction symlink')
      }
      const descriptor = this.backend.library.symbols.openat(
        parent.descriptor,
        this.backend.ptr(parent.name),
        process.platform === 'darwin' ? 0x20_0000 : 0x20_0000 | constants.O_NOFOLLOW,
        0,
      )
      if (descriptor < 0) throw new Error('cannot inspect created reconstruction symlink')
      try {
        const identity = descriptorIdentity(descriptor)
        if (identity.kind !== 'symlink')
          throw new Error('created symlink changed before inspection')
        this.createdLeaves.push({ path: clonePath(path), identity })
      } finally {
        this.backend.library.symbols.close(descriptor)
      }
    } finally {
      this.closeParents(parent.opened)
    }
  }

  async close(): Promise<void> {
    await this.root.close()
  }
}

/** Inventory a tree through directory descriptors; pathname swaps cannot hide or add entries. */
export async function inventoryConfinedTree(
  path: string,
  bounds: {
    maximumEntries: number
    maximumFileBytes: number
    maximumBytes: number
    maximumDepth?: number
    afterEntryOpen?: (path: readonly Uint8Array[]) => Promise<void>
    allowSymlinks?: boolean
    rootNames?: readonly string[]
    includeSnapshotToken?: boolean
  },
) {
  const inventory = await ConfinedWriter.inspectTree(path, bounds)
  if (!bounds.allowSymlinks && inventory.some(entry => entry.kind === 'symlink'))
    throw new Error('confined inventory refuses symbolic links')
  return inventory
}
