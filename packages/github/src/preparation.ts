import { createHash } from 'node:crypto'

import {
  canonicalJson,
  parseCodeManifest,
  type EvidenceTransformation,
  type ObjectRef,
} from '@factory/contract'
import { SanitizationError, type createSanitizer } from '@factory/sanitization'

import type { PrObjectStore } from './index'

export type Sanitizer = ReturnType<typeof createSanitizer>

export function requireUnchanged(sanitizer: Sanitizer, values: readonly (string | undefined)[]) {
  if (values.some(value => value !== undefined && sanitizer.text(value).redacted))
    throw new SanitizationError('unsupported-content')
}

function quotedGitPath(token: string): string {
  if (!token.startsWith('"')) return token
  const chunks: Uint8Array[] = []
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  }
  for (let offset = 1; offset < token.length - 1; ) {
    if (token[offset] !== '\\') {
      const end = token.indexOf('\\', offset)
      const finish = end === -1 ? token.length - 1 : end
      chunks.push(Buffer.from(token.slice(offset, finish)))
      offset = finish
      continue
    }
    const octal = /^[0-7]{3}/.exec(token.slice(offset + 1))?.[0]
    const code = octal ? Number.parseInt(octal, 8) : escapes[token[offset + 1]!]
    if (code === undefined || code > 255) throw new Error('invalid quoted Git path')
    chunks.push(Uint8Array.of(code))
    offset += octal ? 4 : 2
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
}

export function preparePatch(
  bytes: Uint8Array,
  sanitizer: Sanitizer,
  transformation: EvidenceTransformation,
): Uint8Array {
  const omit = (reason: EvidenceTransformation['omissionReasons'][number]) => {
    transformation.omissionReasons = [...new Set([...transformation.omissionReasons, reason])]
    return `[Factory omitted patch section: ${reason}]\n`
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return new TextEncoder().encode(omit('unsupported-text'))
  }
  const sections = text
    .split(/(?=^diff --git |^From [0-9a-f]{40,64} Mon Sep 17 00:00:00 2001$)/m)
    .map(section => {
      if (/^(?:GIT binary patch|Binary files .* differ)$/m.test(section))
        return omit('unsupported-text')
      if (section.startsWith('diff --git ')) {
        const header = section.split('\n', 1)[0]!
        const match = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(
          header,
        )
        if (!match || (!match[1]!.startsWith('"') && header.split(' b/').length > 2))
          return omit('sensitive-path')
        let paths: string[]
        try {
          paths = [quotedGitPath(match[1]!), quotedGitPath(match[2]!)]
        } catch {
          return omit('sensitive-path')
        }
        if (
          paths.some(
            (path, index) =>
              !path.startsWith(index === 0 ? 'a/' : 'b/') ||
              path.includes('\0') ||
              path
                .slice(2)
                .split('/')
                .some(part => part === '' || part === '.' || part === '..') ||
              sanitizer.text(path).redacted,
          )
        )
          return omit('sensitive-path')
        if (paths.some(path => path.split('/').at(-1)!.startsWith('.env')))
          return omit('env-source')
      } else {
        section = section
          .split(/(?<=\n)/)
          .map(line => {
            if (!/^\s*(?:(?:create|delete) mode \d+ |(?:rename|copy) |[^|\n]+\|)/.test(line))
              return line
            try {
              const paths = [...line.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(match =>
                quotedGitPath(match[0]),
              )
              if (
                sanitizer.text(line).redacted ||
                paths.some(path => sanitizer.text(path).redacted)
              )
                return omit('sensitive-path')
            } catch {
              return omit('sensitive-path')
            }
            return line
          })
          .join('')
      }
      const safe = sanitizer.text(section)
      transformation.redacted ||= safe.redacted
      return safe.text
    })
  return new TextEncoder().encode(sections.join(''))
}

/** One bounded acquisition freezes all safe leaves before publication starts. */
export class PreparedPrObjects implements PrObjectStore {
  readonly transformation: EvidenceTransformation = {
    policy: 'evidence-sanitization-1',
    redacted: false,
    omittedCharacters: 0,
    omissionReasons: [],
  }
  private readonly pending = new Map<string, { bytes: Uint8Array; ref: ObjectRef }>()
  private bytes = 0
  private closed = false
  constructor(private readonly maximumBytes: number) {}

  async put(bytes: Uint8Array, metadata: { mediaType: string; role: string }): Promise<ObjectRef> {
    if (this.closed) throw new Error('PR preparation is closed')
    this.bytes += bytes.byteLength
    if (this.bytes > this.maximumBytes) throw new SanitizationError('sanitization-limit')
    const ref: ObjectRef = {
      algorithm: 'sha256',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      ...metadata,
    }
    this.pending.set(ref.sha256, { bytes: bytes.slice(), ref })
    return ref
  }

  close() {
    this.closed = true
  }

  verifyCodeManifest(ref: ObjectRef) {
    const manifest = this.pending.get(ref.sha256)
    if (!manifest || canonicalJson(manifest.ref) !== canonicalJson(ref))
      throw new Error('PR code manifest was not prepared')
    const parsed = parseCodeManifest(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes)),
    )
    if (parsed.transformation) {
      this.transformation.redacted ||= parsed.transformation.redacted
      this.transformation.omittedCharacters += parsed.transformation.omittedCharacters
      this.transformation.omissionReasons = [
        ...new Set([
          ...this.transformation.omissionReasons,
          ...parsed.transformation.omissionReasons,
        ]),
      ]
    }
    for (const entry of parsed.entries) {
      if (entry.kind === 'gitlink') continue
      const object = this.pending.get(entry.object.sha256)
      if (!object || canonicalJson(object.ref) !== canonicalJson(entry.object))
        throw new Error('PR source was not prepared')
    }
  }

  async publish(store: PrObjectStore, deadline: number): Promise<void> {
    this.close()
    for (const item of this.pending.values()) {
      if (performance.now() >= deadline) throw new Error('PR publication deadline elapsed')
      const ref = await store.put(item.bytes, item.ref)
      if (canonicalJson(ref) !== canonicalJson(item.ref))
        throw new Error('PR object store changed prepared evidence')
    }
  }
}
