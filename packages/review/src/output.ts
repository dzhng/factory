import { createHash } from 'node:crypto'

import {
  canonicalJson,
  type ObjectRef,
  type RecordId,
  type ReviewLedgerEntry,
} from '@factory/contract'

export type ParsedSemanticOutput = {
  entries: readonly ReviewLedgerEntry[]
  incomplete: boolean
  /** Exact bounded, valid UTF-8 provider bytes authorized for immutable publication. */
  response: Uint8Array
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function deterministicEntryId(reviewId: RecordId, value: unknown): RecordId {
  const bytes = createHash('sha256')
    .update(reviewId)
    .update('\0')
    .update(canonicalJson(value))
    .digest()
  let number = 0n
  for (const byte of bytes.subarray(0, 16)) number = (number << 8n) | BigInt(byte)
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = `${CROCKFORD[Number(number & 31n)]}${encoded}`
    number >>= 5n
  }
  return `entry_${encoded}` as RecordId
}

function exactObject(left: ObjectRef, right: ObjectRef): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function parseLine(
  line: string,
  inventory: readonly ObjectRef[],
  reviewId: RecordId,
): ReviewLedgerEntry | undefined {
  if (Buffer.byteLength(line) > 64 * 1024) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') return undefined
  const value = parsed as Record<string, unknown>
  const finding = value.kind === 'finding'
  const expectedKeys = finding
    ? ['evidence', 'kind', 'severity', 'summary']
    : ['evidence', 'kind', 'summary']
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(expectedKeys)) return undefined
  if (!['decision', 'finding', 'summary'].includes(value.kind as string)) return undefined
  if (
    typeof value.summary !== 'string' ||
    value.summary.trim().length === 0 ||
    Buffer.byteLength(value.summary) > 16 * 1024 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    value.evidence.length > 128
  )
    return undefined
  if (finding && !['low', 'medium', 'high', 'critical'].includes(value.severity as string)) {
    return undefined
  }
  const evidence: { object: ObjectRef; locator?: string }[] = []
  for (const candidate of value.evidence) {
    if (candidate === null || Array.isArray(candidate) || typeof candidate !== 'object') {
      return undefined
    }
    const citation = candidate as Record<string, unknown>
    if (
      Object.keys(citation).some(key => !['object', 'locator'].includes(key)) ||
      citation.object === null ||
      Array.isArray(citation.object) ||
      typeof citation.object !== 'object'
    )
      return undefined
    const object = citation.object as ObjectRef
    if (!inventory.some(item => exactObject(item, object))) return undefined
    if (
      citation.locator !== undefined &&
      (typeof citation.locator !== 'string' ||
        citation.locator.trim().length === 0 ||
        Buffer.byteLength(citation.locator) > 1024)
    )
      return undefined
    evidence.push({
      object,
      ...(citation.locator === undefined ? {} : { locator: citation.locator }),
    })
  }
  evidence.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  if (new Set(evidence.map(citation => canonicalJson(citation))).size !== evidence.length) {
    return undefined
  }
  const semantic = {
    kind: value.kind,
    ...(finding ? { severity: value.severity } : {}),
    summary: value.summary,
    evidence,
  }
  return { entryId: deterministicEntryId(reviewId, semantic), ...semantic } as ReviewLedgerEntry
}

/** Parse bounded JSONL so a valid prefix remains useful when a provider is interrupted. */
export function parseSemanticOutput(
  raw: Uint8Array,
  inventory: readonly ObjectRef[],
  reviewId: RecordId,
): ParsedSemanticOutput {
  const bounded = raw.subarray(0, 1024 * 1024)
  let incomplete = raw.byteLength > bounded.byteLength
  let validBytes = bounded.byteLength
  for (let index = 0; index < bounded.byteLength; ) {
    const first = bounded[index]!
    let width = 1
    if (first <= 0x7f) width = 1
    else if (first >= 0xc2 && first <= 0xdf) width = 2
    else if (first >= 0xe0 && first <= 0xef) width = 3
    else if (first >= 0xf0 && first <= 0xf4) width = 4
    else {
      validBytes = index
      incomplete = true
      break
    }
    if (index + width > bounded.byteLength) {
      validBytes = index
      incomplete = true
      break
    }
    if (width > 1) {
      const second = bounded[index + 1]!
      const continuation = (byte: number) => byte >= 0x80 && byte <= 0xbf
      const validSecond =
        continuation(second) &&
        !(first === 0xe0 && second < 0xa0) &&
        !(first === 0xed && second > 0x9f) &&
        !(first === 0xf0 && second < 0x90) &&
        !(first === 0xf4 && second > 0x8f)
      if (
        !validSecond ||
        (width >= 3 && !continuation(bounded[index + 2]!)) ||
        (width === 4 && !continuation(bounded[index + 3]!))
      ) {
        validBytes = index
        incomplete = true
        break
      }
    }
    index += width
  }
  const response = bounded.subarray(0, validBytes).slice()
  const lineBytes: Uint8Array[] = []
  let start = 0
  for (let index = 0; index < response.byteLength; index += 1) {
    if (response[index] !== 0x0a) continue
    lineBytes.push(response.subarray(start, index))
    start = index + 1
  }
  if (start < response.byteLength) lineBytes.push(response.subarray(start))
  const entries: ReviewLedgerEntry[] = []
  const identities = new Set<string>()
  let ledgerBytes = 0
  for (const bytes of lineBytes) {
    let line: string
    try {
      line = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      incomplete = true
      continue
    }
    if (line.length === 0) {
      incomplete = true
      continue
    }
    const entry = parseLine(line, inventory, reviewId)
    if (entry === undefined || identities.has(entry.entryId)) {
      incomplete = true
      continue
    }
    if (entries.length >= 500) {
      incomplete = true
      continue
    }
    const encodedBytes = Buffer.byteLength(canonicalJson(entry))
    if (ledgerBytes + encodedBytes > 1024 * 1024) {
      incomplete = true
      continue
    }
    identities.add(entry.entryId)
    entries.push(entry)
    ledgerBytes += encodedBytes
  }
  entries.sort((left, right) => left.entryId.localeCompare(right.entryId))
  return { entries, incomplete, response }
}
