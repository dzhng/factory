import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertOwnedRecordPath,
  objectOwnedPath,
  validateObjectRef,
  type ObjectRef,
  type OwnedPath,
} from '@factory/contract'
import { inventoryConfinedTree, readConfinedFile } from '@factory/repository'

export interface PortableRecordReader {
  read(
    path: string,
  ): Promise<
    | { kind: 'readable'; bytes: Uint8Array }
    | { kind: 'missing'; detail: string }
    | { kind: 'unsafe'; detail: string }
  >
  getObject(
    ref: ObjectRef,
  ): Promise<
    | { kind: 'readable'; bytes: Uint8Array }
    | { kind: 'missing'; detail: string }
    | { kind: 'unsafe'; detail: string }
    | { kind: 'excluded-by-limit'; detail: string }
  >
}

export interface ReviewRepositoryReader extends PortableRecordReader {
  /** One bounded descriptor-confined snapshot of every immutable owned record path. */
  inventory(): Promise<readonly OwnedPath[]>
}

const trustedReaders = new WeakSet<ReviewRepositoryReader>()
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const segments = (path: string) => path.split('/').map(segment => new TextEncoder().encode(segment))

/** Bind review discovery to one complete descriptor-confined `.factory` tree snapshot. */
export async function openReviewRepositoryReader(
  factoryRoot: string,
): Promise<ReviewRepositoryReader> {
  const before = await lstat(factoryRoot, { bigint: true })
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new Error('review repository root must be an ordinary directory')
  const ownedRoots = [
    'sessions',
    'repository-observations',
    'pull-requests',
    'review-triggers',
    'reviews',
    'decisions',
  ] as const
  const inventoryBounds = {
    maximumEntries: 200_000,
    maximumFileBytes: 4 * 1024 * 1024,
    maximumBytes: 64 * 1024 * 1024,
    maximumDepth: 16,
    allowSymlinks: true,
    rootNames: ownedRoots,
    includeSnapshotToken: true,
  } as const
  const tree = await inventoryConfinedTree(factoryRoot, inventoryBounds)
  const after = await lstat(factoryRoot, { bigint: true })
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino)
    throw new Error('review repository root changed during inventory')
  const expectedRoot = { dev: after.dev, ino: after.ino }
  const paths = tree
    .filter(
      entry =>
        (entry.kind === 'file' || entry.kind === 'symlink') &&
        entry.path !== 'manifest.json' &&
        entry.path !== 'config.json' &&
        !entry.path.startsWith('objects/'),
    )
    .map(entry => {
      assertOwnedRecordPath(entry.path)
      return entry.path as OwnedPath
    })
    .sort()
  const classifyFailure = (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    return /symbolic|not an ordinary|confin|directory/.test(detail)
      ? ({ kind: 'unsafe', detail } as const)
      : ({ kind: 'missing', detail } as const)
  }
  const recordBytes = new Map<OwnedPath, Uint8Array>()
  const unsafePaths = new Set(
    tree.filter(entry => entry.kind === 'symlink').map(entry => entry.path as OwnedPath),
  )
  let aggregateRecordBytes = 0
  for (const path of paths) {
    if (unsafePaths.has(path)) continue
    const value = await readConfinedFile(factoryRoot, segments(path), {
      maximumBytes: 4 * 1024 * 1024,
      expectedRoot,
    })
    aggregateRecordBytes += value.byteLength
    if (aggregateRecordBytes > 64 * 1024 * 1024)
      throw new Error('review repository records exceed aggregate bound')
    recordBytes.set(path, value)
  }
  const verifiedTree = await inventoryConfinedTree(factoryRoot, inventoryBounds)
  if (JSON.stringify(verifiedTree) !== JSON.stringify(tree))
    throw new Error('review repository records changed while snapshotting')
  const reader: ReviewRepositoryReader = Object.freeze({
    inventory: async () => [...paths],
    read: async (path: string) => {
      try {
        assertOwnedRecordPath(path)
        if (!paths.includes(path as OwnedPath)) return { kind: 'missing' as const, detail: path }
        if (unsafePaths.has(path as OwnedPath))
          return { kind: 'unsafe' as const, detail: `owned record is a symbolic link: ${path}` }
        return {
          kind: 'readable' as const,
          bytes: new Uint8Array(recordBytes.get(path as OwnedPath)!),
        }
      } catch (error) {
        return classifyFailure(error)
      }
    },
    getObject: async (reference: ObjectRef) => {
      try {
        validateObjectRef(reference)
        if (reference.bytes > 64 * 1024 * 1024)
          return { kind: 'excluded-by-limit' as const, detail: 'object exceeds read limit' }
        const path = objectOwnedPath(reference.sha256)
        try {
          await lstat(join(factoryRoot, path))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return { kind: 'missing' as const, detail: `missing ${path}` }
          throw error
        }
        const value = await readConfinedFile(factoryRoot, segments(path), {
          maximumBytes: reference.bytes,
          expectedRoot,
        })
        if (value.byteLength !== reference.bytes || digest(value) !== reference.sha256)
          throw new Error('object digest or byte length differs from its reference')
        return { kind: 'readable' as const, bytes: value }
      } catch (error) {
        return classifyFailure(error)
      }
    },
  })
  trustedReaders.add(reader)
  return reader
}

export function isTrustedReviewRepositoryReader(reader: ReviewRepositoryReader): boolean {
  return trustedReaders.has(reader)
}
