import {
  canonicalJson,
  validatePublicRecord,
  type JsonValue,
  type OwnedPath,
} from '@factory/contract'

export function validateStructuredRecord(path: OwnedPath, bytes: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
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
      if (canonicalJson(value) !== `${line}\n`)
        throw new TypeError(`${path} contains a non-canonical JSONL record`)
      validatePublicRecord(path, value)
    }
    return
  }
  validatePublicRecord(path, text)
}
