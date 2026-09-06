import type { EvidenceTransformation, JsonValue } from '@factory/contract'
import type { CaptureProvider } from '@factory/runtime-journal'
import { SanitizationError, type createSanitizer } from '@factory/sanitization'

export type PreparedEvidence = {
  bytes: Uint8Array
  transformation: EvidenceTransformation
}

type Sanitizer = ReturnType<typeof createSanitizer>
type ObjectValue = Record<string, JsonValue>

class Omission extends Error {
  constructor(readonly reason: EvidenceTransformation['omissionReasons'][number]) {
    super(reason)
  }
}

function object(value: JsonValue | undefined): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function prepareEvidence(
  provider: CaptureProvider,
  kind: 'hook' | 'transcript',
  bytes: Uint8Array,
  sanitizer: Sanitizer,
): PreparedEvidence {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new SanitizationError('sanitization-limit')
  const transformation: EvidenceTransformation = {
    policy: 'evidence-sanitization-1',
    redacted: false,
    omittedCharacters: 0,
    omissionReasons: [],
  }
  const omit = (reason: EvidenceTransformation['omissionReasons'][number]) => {
    transformation.omissionReasons = [...new Set([...transformation.omissionReasons, reason])]
  }
  const resultText = (blocks: readonly string[]) => {
    const result = sanitizer.toolResult(blocks)
    transformation.redacted ||= result.redacted
    transformation.omittedCharacters += result.omittedCharacters
    return result.text
  }
  const identities = (value: ObjectValue, keys: readonly string[]) => {
    for (const key of keys) {
      if (typeof value[key] === 'string' && sanitizer.text(value[key]).redacted) {
        transformation.redacted = true
        throw new Omission('sensitive-path')
      }
    }
  }
  const transform = (value: JsonValue): JsonValue => {
    if (object(value) && provider === 'codex' && kind === 'transcript' && object(value.payload)) {
      if (value.type === 'session_meta') identities(value.payload, ['id'])
      if (value.type === 'turn_context') identities(value.payload, ['turn_id'])
      if (
        value.type === 'response_item' &&
        (value.payload.type === 'function_call' || value.payload.type === 'function_call_output')
      )
        identities(value.payload, ['call_id'])
      if (
        value.type === 'response_item' &&
        value.payload.type === 'message' &&
        Array.isArray(value.payload.content)
      ) {
        const textType = value.payload.role === 'assistant' ? 'output_text' : 'input_text'
        value.payload.content = value.payload.content.map(block => {
          if (
            object(block) &&
            typeof block.type === 'string' &&
            ['input_image', 'image', 'image_url'].includes(block.type)
          ) {
            omit('nontext-attachment')
            return { type: textType, text: '[Factory omitted nontext attachment]' }
          }
          return block
        })
      }
    }
    if (object(value))
      identities(
        value,
        kind === 'hook'
          ? ['session_id', 'tool_use_id', 'turn_id', 'prompt_id', 'event_id']
          : ['uuid', 'sessionId', 'requestId'],
      )
    if (
      object(value) &&
      kind === 'hook' &&
      value.hook_event_name === 'PostToolUse' &&
      object(value.tool_response)
    ) {
      const response = value.tool_response
      if (provider === 'codex' && typeof response.output === 'string')
        response.output = resultText([response.output])
      if (provider === 'claude') {
        if (
          typeof response.stdout === 'string' &&
          response.stdout &&
          typeof response.stderr === 'string' &&
          response.stderr
        ) {
          response.stdout = resultText([
            '[Combined stdout and stderr]\n',
            response.stdout,
            response.stderr,
          ])
          response.stderr = ''
        } else {
          for (const field of ['stdout', 'stderr'])
            if (typeof response[field] === 'string') response[field] = resultText([response[field]])
        }
      }
    }
    if (
      object(value) &&
      provider === 'codex' &&
      kind === 'transcript' &&
      value.type === 'response_item' &&
      object(value.payload) &&
      value.payload.type === 'function_call_output' &&
      typeof value.payload.output === 'string'
    ) {
      value.payload.output = resultText([value.payload.output])
    }
    if (
      object(value) &&
      provider === 'claude' &&
      kind === 'transcript' &&
      (value.type === 'user' || value.type === 'assistant') &&
      object(value.message) &&
      Array.isArray(value.message.content)
    ) {
      value.message.content = value.message.content.map(block => {
        if (object(block) && block.type === 'tool_result') identities(block, ['tool_use_id'])
        if (object(block) && block.type === 'tool_use') identities(block, ['id'])
        if (object(block) && (block.type === 'image' || block.type === 'document')) {
          omit('nontext-attachment')
          return { type: 'text', text: '[Factory omitted nontext attachment]' }
        }
        if (object(block) && block.type === 'tool_result' && typeof block.content === 'string')
          block.content = resultText([block.content])
        else if (object(block) && block.type === 'tool_result' && Array.isArray(block.content)) {
          const text: string[] = []
          for (const part of block.content) {
            if (object(part) && part.type === 'text' && typeof part.text === 'string')
              text.push(part.text)
            else omit('nontext-attachment')
          }
          block.content = [{ type: 'text', text: resultText(text) }]
        }
        return block
      })
    }
    const safe = sanitizer.json(value)
    transformation.redacted ||= safe.redacted
    return safe.value
  }
  const transformLine = (line: Uint8Array): string => {
    const previousOmitted = transformation.omittedCharacters
    try {
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(line)
      } catch {
        throw new Omission('unsupported-text')
      }
      return JSON.stringify(transform(JSON.parse(text)))
    } catch (error) {
      const reason =
        error instanceof Omission
          ? error.reason
          : error instanceof SyntaxError
            ? 'malformed-record'
            : error instanceof SanitizationError && error.code === 'json-key-collision'
              ? 'json-key-collision'
              : error instanceof SanitizationError && error.code === 'unsupported-content'
                ? 'unsupported-text'
                : undefined
      if (!reason) throw error
      transformation.omittedCharacters = previousOmitted
      transformation.redacted ||= reason === 'json-key-collision'
      omit(reason)
      return JSON.stringify({ type: 'factory_omission', reason })
    }
  }
  const output: string[] = []
  let outputBytes = 0
  const append = (line: Uint8Array) => {
    const safe = transformLine(line) + '\n'
    outputBytes += Buffer.byteLength(safe)
    if (outputBytes > 64 * 1024 * 1024) throw new SanitizationError('sanitization-limit')
    output.push(safe)
  }
  if (kind === 'hook') append(bytes)
  else {
    let start = 0
    for (let index = 0; index < bytes.byteLength; index++) {
      if (bytes[index] === 10) {
        append(bytes.subarray(start, index))
        start = index + 1
      }
    }
    if (start < bytes.byteLength) append(bytes.subarray(start))
  }
  return { bytes: new TextEncoder().encode(output.join('')), transformation }
}
