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
      fdopendir: { args: ['i32'], returns: 'ptr' },
      readdir: { args: ['ptr'], returns: 'ptr' },
      closedir: { args: ['ptr'], returns: 'i32' },
      close: { args: ['i32'], returns: 'i32' },
    },
  )
  const errnoBuffer =
    process.platform === 'darwin'
      ? (() => {
          const errnoLibrary = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
            __error: { args: [], returns: 'ptr' },
          })
          return () => {
            const pointer = errnoLibrary.symbols.__error()
            if (pointer === null) throw new Error('native errno pointer is unavailable')
            return Buffer.from(ffi.toArrayBuffer(pointer, 0, 4))
          }
        })()
      : (() => {
          const errnoLibrary = ffi.dlopen('libc.so.6', {
            __errno_location: { args: [], returns: 'ptr' },
          })
          return () => {
            const pointer = errnoLibrary.symbols.__errno_location()
            if (pointer === null) throw new Error('native errno pointer is unavailable')
            return Buffer.from(ffi.toArrayBuffer(pointer, 0, 4))
          }
        })()
  return {
    library,
    ptr: ffi.ptr,
    toArrayBuffer: ffi.toArrayBuffer,
    errnoBuffer,
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
  const root = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const opened: number[] = []
  try {
    let parent = root.fd
    for (const segment of path.slice(0, -1)) {
      const descriptor = backend.library.symbols.openat(parent, backend.ptr(confinedSegment(segment)), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 0)
      if (descriptor < 0) throw new Error('cannot open confined read directory')
      opened.push(descriptor)
      parent = descriptor
    }
    const descriptor = backend.library.symbols.openat(parent, backend.ptr(confinedSegment(path.at(-1)!)), constants.O_RDONLY | constants.O_NOFOLLOW, 0)
    if (descriptor < 0) throw new Error('cannot open confined read file')
    opened.push(descriptor)
    const before = descriptorIdentity(descriptor)
    if (before.kind !== 'file') throw new Error('confined read target is not an ordinary file')
    if (before.size > BigInt(options.maximumBytes)) throw new Error('confined read exceeds its size bound')
    await options.afterOpen?.()
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset)
      if (count === 0) throw new Error('confined read ended before the verified size')
      offset += count
    }
    if (!sameNativeState(before, descriptorIdentity(descriptor))) throw new Error('confined read target changed while reading')
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

  private directoryEntries(descriptor: number, maximumEntries: number): Buffer[] {
    const enumeration = this.backend.library.symbols.openat(
      descriptor,
      this.backend.ptr(cString(Buffer.from('.'))),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      0,
    )
    if (enumeration < 0) throw new Error('cannot open confined reconstruction inventory')
    const directory = this.backend.library.symbols.fdopendir(enumeration)
    if (directory === null) {
      this.backend.library.symbols.close(enumeration)
      throw new Error('cannot enumerate confined reconstruction directory')
    }
    const entries: Buffer[] = []
    const nameOffset = process.platform === 'darwin' ? 21 : 19
    const nameCapacity = process.platform === 'darwin' ? 1024 : 256
    try {
      for (;;) {
        const errno = this.backend.errnoBuffer()
        errno.writeInt32LE(0)
        const entry = this.backend.library.symbols.readdir(directory)
        if (entry === null) {
          if (errno.readInt32LE() !== 0) {
            throw new Error('cannot read confined reconstruction directory')
          }
          break
        }
        const field = Buffer.from(this.backend.toArrayBuffer(entry, nameOffset, nameCapacity))
        const end = field.indexOf(0)
        if (end < 0) throw new Error('invalid native directory entry')
        const name = Buffer.from(field.subarray(0, end))
        if (name.equals(Buffer.from('.')) || name.equals(Buffer.from('..'))) continue
        entries.push(name)
        if (entries.length > maximumEntries) {
          throw new Error('reconstruction inventory exceeds the expected tree')
        }
      }
    } finally {
      this.backend.library.symbols.closedir(directory)
    }
    return entries.sort(Buffer.compare)
  }

  private async inventory(
    maximumEntries: number,
    maximumFileBytes: number,
    maximumBytes: number,
    consumed = { bytes: 0 },
    descriptor = this.root.fd,
    prefix: Buffer[] = [],
    inventory: string[] = [],
  ): Promise<string[]> {
    const directoryBefore = descriptorIdentity(descriptor)
    if (directoryBefore.kind !== 'directory')
      throw new Error('reconstruction entry changed during inventory')
    const entries = this.directoryEntries(descriptor, maximumEntries - inventory.length)
    for (const name of entries) {
      const path = [...prefix, name]
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
          consumed,
          child,
          path,
          inventory,
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
    const finalEntries = this.directoryEntries(descriptor, entries.length)
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
