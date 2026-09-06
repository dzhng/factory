import { createHash } from 'node:crypto'

import { validateObjectRef, type ObjectRef, type OwnedPath } from '@factory/contract'

declare const prepared: unique symbol
export type PreparedObject = { readonly reference: ObjectRef; readonly [prepared]: true }
export type PreparedRecord = { readonly path: OwnedPath; readonly [prepared]: true }
type ObjectSnapshot = { repositoryRoot: string; reference: ObjectRef; bytes: Uint8Array }
type RecordSnapshot = { repositoryRoot: string; path: OwnedPath; bytes: Uint8Array }
const objects = new WeakMap<PreparedObject, ObjectSnapshot>()
const records = new WeakMap<PreparedRecord, RecordSnapshot>()

// Internal mint: only preparation and verified private journal/attempt readers may
// restore authority. Never export these functions from the repository API.
export function restorePreparedObject(
  repositoryRoot: string,
  reference: ObjectRef,
  bytes: Uint8Array,
): PreparedObject {
  validateObjectRef(reference)
  if (
    reference.bytes !== bytes.byteLength ||
    reference.sha256 !== createHash('sha256').update(bytes).digest('hex')
  )
    throw new TypeError('prepared object identity differs from bytes')
  const copy = Object.freeze({ ...reference })
  const capability = Object.freeze({ reference: copy }) as PreparedObject
  objects.set(capability, { repositoryRoot, reference: copy, bytes: Uint8Array.from(bytes) })
  return capability
}

export function restorePreparedRecord(
  repositoryRoot: string,
  path: OwnedPath,
  bytes: Uint8Array,
): PreparedRecord {
  const capability = Object.freeze({ path }) as PreparedRecord
  records.set(capability, { repositoryRoot, path, bytes: Uint8Array.from(bytes) })
  return capability
}

function assertSnapshotBound(bytes: Uint8Array, bounds?: { maximumBytes: number }): void {
  if (
    bounds !== undefined &&
    (!Number.isSafeInteger(bounds.maximumBytes) ||
      bounds.maximumBytes < 0 ||
      bytes.byteLength > bounds.maximumBytes)
  )
    throw new TypeError('prepared content exceeds snapshot byte bound')
}

export function snapshotPreparedObject(
  capability: PreparedObject,
  bounds?: { maximumBytes: number },
): ObjectSnapshot {
  const snapshot = objects.get(capability)
  if (!snapshot) throw new TypeError('object requires a genuine prepared capability')
  assertSnapshotBound(snapshot.bytes, bounds)
  return {
    ...snapshot,
    reference: { ...snapshot.reference },
    bytes: Uint8Array.from(snapshot.bytes),
  }
}

export function snapshotPreparedRecord(
  capability: PreparedRecord,
  bounds?: { maximumBytes: number },
): RecordSnapshot {
  const snapshot = records.get(capability)
  if (!snapshot) throw new TypeError('record requires a genuine prepared capability')
  assertSnapshotBound(snapshot.bytes, bounds)
  return { ...snapshot, bytes: Uint8Array.from(snapshot.bytes) }
}
