import { createHash } from 'node:crypto'

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
  const tree = await inventoryConfinedTree(factoryRoot, {
    maximumEntries: 200_000,
    maximumFileBytes: 64 * 1024 * 1024,
    maximumBytes: 512 * 1024 * 1024,
    maximumDepth: 16,
  })
  const paths = tree
    .filter(
      entry =>
        entry.kind === 'file' &&
        entry.path !== 'manifest.json' &&
        entry.path !== 'config.json' &&
        !entry.path.startsWith('objects/'),
    )
    .map(entry => {
      assertOwnedRecordPath(entry.path)
      return entry.path as OwnedPath
    })
    .sort()
  const objectPaths = new Set(
    tree
      .filter(entry => entry.kind === 'file' && entry.path.startsWith('objects/sha256/'))
      .map(entry => entry.path),
  )
  const classifyFailure = (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    return /symbolic|not an ordinary|confin|directory/.test(detail)
      ? ({ kind: 'unsafe', detail } as const)
      : ({ kind: 'missing', detail } as const)
  }
  const reader: ReviewRepositoryReader = Object.freeze({
    inventory: async () => [...paths],
    read: async (path: string) => {
      try {
        assertOwnedRecordPath(path)
        if (!paths.includes(path as OwnedPath)) return { kind: 'missing' as const, detail: path }
        return {
          kind: 'readable' as const,
          bytes: await readConfinedFile(factoryRoot, segments(path), {
            maximumBytes: 4 * 1024 * 1024,
          }),
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
        if (!objectPaths.has(path)) return { kind: 'missing' as const, detail: `missing ${path}` }
        const value = await readConfinedFile(factoryRoot, segments(path), {
          maximumBytes: reference.bytes,
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

/** Test-only adapter; production callers must use openReviewRepositoryReader. */
export function trustReviewRepositoryReaderForTesting(
  reader: ReviewRepositoryReader,
): ReviewRepositoryReader {
  trustedReaders.add(reader)
  return reader
}
