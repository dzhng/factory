import { createHash } from 'node:crypto'

import {
  canonicalJson,
  compareChoiceAuditEntries,
  validateChoiceAuditEvent,
  type ChoiceAuditEntry,
  type ChoiceAuditEvent,
  type ChoiceAuditSummary,
  type ObjectRef,
  type RecordId,
} from '@factory/contract'

export type AcceptedAuditDraft = {
  entries: readonly ChoiceAuditEntry[]
  summary?: ChoiceAuditSummary
  incomplete: boolean
  submissions: Uint8Array
}

function entryId(reviewId: RecordId, value: unknown): RecordId {
  const bytes = createHash('sha256')
    .update(reviewId)
    .update('\0')
    .update(canonicalJson(value))
    .digest()
  let number = 0n
  for (const byte of bytes.subarray(0, 16)) number = (number << 8n) | BigInt(byte)
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = `${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(number & 31n)]}${encoded}`
    number >>= 5n
  }
  return `entry_${encoded}` as RecordId
}

/** Accept untrusted typed submissions without giving model text publication authority. */
export function acceptAuditDraft(
  events: readonly unknown[],
  inventory: readonly ObjectRef[],
  reviewId: RecordId,
): AcceptedAuditDraft {
  const entries = new Map<string, ChoiceAuditEntry>()
  const accepted: ChoiceAuditEvent[] = []
  const authority = new Set(inventory.map(object => canonicalJson(object)))
  let summary: ChoiceAuditSummary | undefined
  let finished = false
  let invalid = false
  let bytes = 0
  let ledgerBytes = Buffer.byteLength(canonicalJson({ schemaVersion: 1, reviewId, entries: [] }))
  for (const event of events) {
    try {
      const encoded = canonicalJson(event)
      bytes += Buffer.byteLength(encoded)
      if (bytes > 1024 * 1024) {
        invalid = true
        break
      }
      const value: unknown = JSON.parse(encoded)
      validateChoiceAuditEvent(value)
      if (value.kind === 'finish') {
        if (!summary || (entries.size === 0 && !summary.noChoiceRationale))
          throw new TypeError('unfinished audit')
        if (!finished) accepted.push({ kind: 'finish' })
        finished = true
        continue
      }
      if (finished) throw new TypeError('audit is finished')
      if (value.kind === 'choice') {
        if (!value.choice.evidence.every(citation => authority.has(canonicalJson(citation.object))))
          throw new TypeError('unknown citation')
        const choice = value.choice
        const prior = entries.get(choice.choiceKey)
        const id = entryId(reviewId, choice)
        if (prior) {
          if (prior.entryId !== id) throw new TypeError('conflicting choice key')
          continue
        }
        if (entries.size >= 500) throw new TypeError('choice limit')
        const entry = { ...choice, entryId: id }
        const addedBytes =
          Buffer.byteLength(canonicalJson(entry)) - 1 + (entries.size === 0 ? 0 : 1)
        if (ledgerBytes + addedBytes > 1024 * 1024) throw new TypeError('ledger byte limit')
        ledgerBytes += addedBytes
        entries.set(choice.choiceKey, entry)
        accepted.push({ kind: 'choice', choice })
      } else if (value.kind === 'audit-summary') {
        if (
          !value.summary.evidence.every(citation => authority.has(canonicalJson(citation.object)))
        )
          throw new TypeError('unknown citation')
        if (summary) {
          if (canonicalJson(summary) !== canonicalJson(value.summary))
            throw new TypeError('conflicting summary')
          continue
        }
        const addedBytes =
          Buffer.byteLength(canonicalJson(value.summary)) - 1 + ',"summary":'.length
        if (ledgerBytes + addedBytes > 1024 * 1024) throw new TypeError('ledger byte limit')
        ledgerBytes += addedBytes
        summary = value.summary
        accepted.push({ kind: 'audit-summary', summary })
      } else throw new TypeError('unknown event')
    } catch {
      invalid = true
    }
  }
  return {
    entries: [...entries.values()].sort(compareChoiceAuditEntries),
    ...(summary ? { summary } : {}),
    incomplete: invalid || !finished,
    submissions: new TextEncoder().encode(accepted.map(event => canonicalJson(event)).join('')),
  }
}

/** Decode the canonical tool journal; malformed events cannot erase earlier valid submissions. */
export function readAuditDraft(
  raw: Uint8Array,
  inventory: readonly ObjectRef[],
  reviewId: RecordId,
): AcceptedAuditDraft {
  const events: unknown[] = []
  const bounded = raw.subarray(0, 1024 * 1024)
  let start = 0
  for (let index = 0; index < bounded.byteLength; index += 1) {
    if (bounded[index] !== 10) continue
    try {
      const line = new TextDecoder('utf-8', { fatal: true }).decode(
        bounded.subarray(start, index + 1),
      )
      const event: unknown = JSON.parse(line)
      events.push(canonicalJson(event) === line ? event : null)
    } catch {
      events.push(null)
    }
    start = index + 1
  }
  if (start !== bounded.byteLength || raw.byteLength > bounded.byteLength) events.push(null)
  return acceptAuditDraft(events, inventory, reviewId)
}
