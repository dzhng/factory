import type { JsonValue } from '@factory/contract'

const excludedDirectories = new Set([
  '.git',
  '.factory',
  'node_modules',
  'vendor',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  'coverage',
])

const discoveryBounds = {
  maximumEntries: 100_000,
  maximumDepth: 64,
  maximumFiles: 1000,
  maximumFileBytes: 1024 * 1024,
  maximumBytes: 8 * 1024 * 1024,
  includeFile: (name: string) => name.startsWith('.env'),
  skipDirectory: (name: string) => excludedDirectories.has(name),
  skipNestedRepositories: true,
}

export async function discoverSanitizer(
  readFiles: (bounds: typeof discoveryBounds) => Promise<readonly Uint8Array[]>,
): Promise<ReturnType<typeof createSanitizer>> {
  try {
    const files = await readFiles(discoveryBounds)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return createSanitizer(files.map(bytes => decoder.decode(bytes)))
  } catch (error) {
    if (error instanceof SanitizationError) throw error
    throw new SanitizationError('discovery-unavailable')
  }
}

export class SanitizationError extends Error {
  constructor(
    readonly code:
      | 'invalid-env'
      | 'json-key-collision'
      | 'unsupported-content'
      | 'discovery-unavailable'
      | 'sanitization-limit',
  ) {
    super(code)
    this.name = 'SanitizationError'
  }
}

function envValues(file: string): string[] {
  const values: string[] = []
  let offset = 0
  while (offset < file.length) {
    const spacing = /^[\s\uFEFF]*/.exec(file.slice(offset))![0]
    offset += spacing.length
    if (offset === file.length) break
    if (file[offset] === '#') {
      const end = file.indexOf('\n', offset)
      offset = end === -1 ? file.length : end + 1
      continue
    }
    const assignment = /^(?:export[\t ]+)?([A-Za-z_][A-Za-z_0-9]*)[\t ]*=[\t ]*/.exec(
      file.slice(offset),
    )
    if (!assignment) throw new SanitizationError('invalid-env')
    offset += assignment[0].length
    let value = ''
    let spelling = ''
    const quote = file[offset]
    if (quote === '"' || quote === "'") {
      offset++
      const valueStart = offset
      let closed = false
      while (offset < file.length) {
        const char = file[offset++]!
        if (char === quote) {
          closed = true
          break
        }
        if (quote === '"' && char === '\\') {
          const escaped = file[offset++]
          if (escaped === undefined) throw new SanitizationError('invalid-env')
          const decoded: Record<string, string> = {
            n: '\n',
            r: '\r',
            t: '\t',
            '"': '"',
            '\\': '\\',
          }
          value += decoded[escaped] ?? `\\${escaped}`
        } else value += char
      }
      if (!closed) throw new SanitizationError('invalid-env')
      spelling = file.slice(valueStart, offset - 1)
      const trailing = /^[\t ]*(?:#[^\r\n]*)?(?:\r?\n|$)/.exec(file.slice(offset))
      if (!trailing) throw new SanitizationError('invalid-env')
      offset += trailing[0].length
    } else {
      const end = file.indexOf('\n', offset)
      const line = file.slice(offset, end === -1 ? file.length : end)
      value = line.split('#', 1)[0]!.trim()
      offset = end === -1 ? file.length : end + 1
    }
    if (
      value &&
      (Array.from(value).length >= 8 || /TOKEN|PASSWORD|SECRET|API_KEY/i.test(assignment[1]!))
    ) {
      values.push(value)
      if (spelling && spelling !== value) values.push(spelling)
    }
  }
  return values
}

type Match = { start: number; end: number }

const credentialPatterns = [
  /\b(?:sk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|[sr]k_(?:live|test)_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{36})/g,
  /\bBearer[\t ]+(?<secret>[A-Za-z0-9._~+/-]+=*)/gi,
]

function* credentialMatches(input: string): Generator<Match> {
  for (const pattern of credentialPatterns) {
    for (const item of input.matchAll(pattern)) {
      const secret = item.groups?.secret
      const start = item.index + (secret === undefined ? 0 : item[0].lastIndexOf(secret))
      yield {
        start,
        end: secret === undefined ? item.index + item[0].length : start + secret.length,
      }
    }
  }
  const assignment =
    /\b(?:[A-Za-z_0-9]{0,128}(?:api[_-]?key|token|password|secret)[A-Za-z_0-9]{0,128})["']?[\t ]*[:=][\t ]*/gi
  for (;;) {
    const item = assignment.exec(input)
    if (!item) break
    let start = assignment.lastIndex
    let end = start
    const quote = input[start]
    if (quote === '"' || quote === "'") {
      start++
      end = start
      while (end < input.length && input[end] !== quote) {
        end += input[end] === '\\' && end + 1 < input.length ? 2 : 1
      }
      assignment.lastIndex = end < input.length ? end + 1 : end
    } else {
      while (end < input.length && !/[\s"';,}\]]/.test(input[end]!)) end++
      assignment.lastIndex = Math.max(end, start)
    }
    if (end > start) yield { start, end }
  }
  const begin = /-----BEGIN ((?:[A-Z]{1,16} )?PRIVATE KEY)-----/g
  for (;;) {
    const item = begin.exec(input)
    if (!item) break
    const closing = `-----END ${item[1]}-----`
    const end = input.indexOf(closing, begin.lastIndex)
    const finish = end < 0 ? input.length : end + closing.length
    yield { start: item.index, end: finish }
    begin.lastIndex = finish
  }
}

/** Failure links keep scanning bounded even for long, overlapping env values. */
function exactMatcher(values: readonly string[]) {
  const nodes: { next: Map<string, number>; fallback: number; length: number }[] = [
    { next: new Map(), fallback: 0, length: 0 },
  ]
  for (const value of values) {
    let state = 0
    for (let offset = 0; offset < value.length; offset++) {
      const char = value[offset]!
      let next = nodes[state]!.next.get(char)
      if (next === undefined) {
        if (nodes.length >= 500_000) throw new SanitizationError('sanitization-limit')
        next = nodes.length
        nodes[state]!.next.set(char, next)
        nodes.push({ next: new Map(), fallback: 0, length: 0 })
      }
      state = next
    }
    nodes[state]!.length = value.length
  }
  const queue = [...nodes[0]!.next.values()]
  for (let offset = 0; offset < queue.length; offset++) {
    const state = queue[offset]!
    for (const [char, next] of nodes[state]!.next) {
      let fallback = nodes[state]!.fallback
      while (fallback && !nodes[fallback]!.next.has(char)) fallback = nodes[fallback]!.fallback
      nodes[next]!.fallback = nodes[fallback]!.next.get(char) ?? 0
      nodes[next]!.length = Math.max(nodes[next]!.length, nodes[nodes[next]!.fallback]!.length)
      queue.push(next)
    }
  }
  return function* (text: string): Generator<Match> {
    let state = 0
    for (let offset = 0; offset < text.length; offset++) {
      const char = text[offset]!
      while (state && !nodes[state]!.next.has(char)) state = nodes[state]!.fallback
      state = nodes[state]!.next.get(char) ?? 0
      const length = nodes[state]!.length
      if (length) yield { start: offset + 1 - length, end: offset + 1 }
    }
  }
}

export function createSanitizer(envFiles: readonly string[]) {
  const match = exactMatcher([...new Set(envFiles.flatMap(envValues))])
  const text = (input: string) => {
    if (Buffer.byteLength(input) > 64 * 1024 * 1024)
      throw new SanitizationError('sanitization-limit')
    const spans: Match[] = []
    const markers: Match[] = []
    for (const item of input.matchAll(/\[REDACTED\]/g)) {
      markers.push({ start: item.index, end: item.index + item[0].length })
      if (markers.length > 200_000) throw new SanitizationError('sanitization-limit')
    }
    let markerIndex = 0
    const append = (found: Match) => {
      while (markers[markerIndex] && markers[markerIndex]!.end < found.end) markerIndex++
      const marker = markers[markerIndex]
      if (marker && found.start >= marker.start && found.end <= marker.end) return
      while (spans.length && spans.at(-1)!.end >= found.start) {
        found.start = Math.min(found.start, spans.pop()!.start)
      }
      spans.push(found)
      if (spans.length > 200_000) throw new SanitizationError('sanitization-limit')
    }
    for (const found of match(input)) append(found)
    const matches = [...spans]
    for (const found of credentialMatches(input)) {
      matches.push(found)
      if (matches.length > 200_000) throw new SanitizationError('sanitization-limit')
    }
    matches.sort((a, b) => a.end - b.end || a.start - b.start)
    spans.length = 0
    markerIndex = 0
    for (const found of matches) append(found)
    let offset = 0
    const chunks: string[] = []
    for (const span of spans) {
      chunks.push(input.slice(offset, span.start), '[REDACTED]')
      offset = span.end
    }
    chunks.push(input.slice(offset))
    return { text: chunks.join(''), redacted: spans.length > 0 }
  }
  const json = (input: unknown): { value: JsonValue; redacted: boolean } => {
    let redacted = false
    const visit = (value: unknown, depth: number): JsonValue => {
      if (depth > 64) throw new SanitizationError('unsupported-content')
      if (typeof value === 'string') {
        const result = text(value)
        redacted ||= result.redacted
        return result.text
      }
      if (
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        const safe = text(String(value))
        redacted ||= safe.redacted
        return safe.redacted ? safe.text : value
      }
      if (Array.isArray(value)) return value.map(item => visit(item, depth + 1))
      if (
        typeof value !== 'object' ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      )
        throw new SanitizationError('unsupported-content')
      const result: Record<string, JsonValue> = Object.create(null)
      for (const [key, child] of Object.entries(value)) {
        const safeKey = text(key)
        redacted ||= safeKey.redacted
        if (Object.hasOwn(result, safeKey.text)) throw new SanitizationError('json-key-collision')
        if (
          /api[_-]?key|token|password|secret/i.test(key) &&
          (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') &&
          child !== '' &&
          child !== '[REDACTED]'
        ) {
          result[safeKey.text] = '[REDACTED]'
          redacted = true
        } else result[safeKey.text] = visit(child, depth + 1)
      }
      return result
    }
    return { value: visit(input, 0), redacted }
  }
  const toolResult = (blocks: readonly string[]) => {
    const sanitized = text(blocks.join(''))
    let characters = 0
    let headEnd = 0
    let offset = 0
    const tailStarts = new Uint32Array(1000)
    for (const char of sanitized.text) {
      tailStarts[characters % 1000] = offset
      offset += char.length
      characters++
      if (characters === 3000) headEnd = offset
    }
    const omittedCharacters = Math.max(0, characters - 4000)
    return {
      text:
        omittedCharacters === 0
          ? sanitized.text
          : sanitized.text.slice(0, headEnd) +
            `\n[Factory omitted ${omittedCharacters} characters]\n` +
            sanitized.text.slice(tailStarts[characters % 1000]),
      redacted: sanitized.redacted,
      omittedCharacters,
    }
  }
  return { text, json, toolResult }
}
