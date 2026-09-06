import { expect, test } from 'bun:test'

import { createSanitizer } from '@factory/sanitization'

import { claudeCaptureAdapter, codexCaptureAdapter } from '../src'

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes))

test('Codex structured tool outputs share one text budget and omit nontext payloads', () => {
  for (const type of ['function_call_output', 'custom_tool_call_output']) {
    const prepared = codexCaptureAdapter.prepareEvidence(
      'transcript',
      encode({
        type: 'response_item',
        payload: {
          type,
          call_id: 'call',
          output: [
            { type: 'input_text', text: 'synthetic-' },
            { type: 'input_text', text: 'private-value' + '😀'.repeat(4001) },
            { type: 'input_image', image_url: 'data:image/png;base64,cHJpdmF0ZQ==' },
            { type: 'encrypted_content', encrypted_content: 'opaque-private' },
          ],
        },
      }),
      createSanitizer(['VALUE=synthetic-private-value']),
    )
    expect(decode(prepared.bytes).payload).toEqual({
      type,
      call_id: 'call',
      output: [
        {
          type: 'input_text',
          text:
            '[REDACTED]' +
            '😀'.repeat(2990) +
            '\n[Factory omitted 11 characters]\n' +
            '😀'.repeat(1000),
        },
      ],
    })
    expect(prepared.transformation).toEqual({
      policy: 'evidence-sanitization-1',
      redacted: true,
      omittedCharacters: 11,
      omissionReasons: ['nontext-attachment'],
    })
    expect(new TextDecoder().decode(prepared.bytes)).not.toContain('cHJpdmF0ZQ==')
    expect(new TextDecoder().decode(prepared.bytes)).not.toContain('opaque-private')
  }
})

test('Codex custom tool output is reduced without trimming custom tool input', () => {
  const output = 'x'.repeat(5000)
  const prepared = codexCaptureAdapter.prepareEvidence(
    'transcript',
    encode({
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call', output },
    }),
    createSanitizer([]),
  )
  expect(decode(prepared.bytes).payload).toEqual({
    type: 'custom_tool_call_output',
    call_id: 'call',
    output: 'x'.repeat(3000) + '\n[Factory omitted 1000 characters]\n' + 'x'.repeat(1000),
  })
  expect(prepared.transformation.omittedCharacters).toBe(1000)
  const input = codexCaptureAdapter.prepareEvidence(
    'transcript',
    encode({
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call', input: output },
    }),
    createSanitizer([]),
  )
  expect(decode(input.bytes).payload.input).toBe(output)
})

test('secret collisions redact omission-marker prose without changing structured counts', () => {
  const prepared = codexCaptureAdapter.prepareEvidence(
    'transcript',
    encode({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call', output: 'x'.repeat(5000) },
    }),
    createSanitizer(['TOKEN=1000']),
  )
  expect(decode(prepared.bytes).payload.output).toBe(
    'x'.repeat(3000) + '\n[Factory omitted [REDACTED] characters]\n' + 'x'.repeat(1000),
  )
  expect(prepared.transformation.omittedCharacters).toBe(1000)
  expect(prepared.transformation.redacted).toBe(true)
})

test('Codex native attachments are omitted while opaque image_url fields remain readable', () => {
  for (const type of ['input_image', 'image', 'image_url']) {
    const prepared = codexCaptureAdapter.prepareEvidence(
      'transcript',
      encode({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type, image_url: 'data:image/png;base64,c3ludGhldGlj' },
            { type: 'input_text', text: 'readable sibling' },
          ],
        },
        opaque: { image_url: 'ordinary description' },
      }),
      createSanitizer([]),
    )
    const result = decode(prepared.bytes)
    expect(result.payload.content).toEqual([
      { type: 'input_text', text: '[Factory omitted nontext attachment]' },
      { type: 'input_text', text: 'readable sibling' },
    ])
    expect(result.opaque).toEqual({ image_url: 'ordinary description' })
    expect(prepared.transformation.omissionReasons).toEqual(['nontext-attachment'])
  }
})

test('Codex metadata and call identities cannot collapse to redaction markers', () => {
  for (const record of [
    { type: 'session_meta', payload: { id: 'synthetic-private-value' } },
    { type: 'turn_context', payload: { turn_id: 'synthetic-private-value' } },
    {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'synthetic-private-value', arguments: '{}' },
    },
  ]) {
    const result = codexCaptureAdapter.prepareEvidence(
      'transcript',
      encode(record),
      createSanitizer(['VALUE=synthetic-private-value']),
    )
    expect(decode(result.bytes)).toEqual({ type: 'factory_omission', reason: 'sensitive-path' })
  }
})

test('bounded input cannot expand into unbounded omission evidence', () => {
  expect(() =>
    codexCaptureAdapter.prepareEvidence(
      'transcript',
      new Uint8Array(1_300_000).fill(10),
      createSanitizer([]),
    ),
  ).toThrow('sanitization-limit')
}, 30_000) // Exercises the real 64 MiB expansion bound, not a five-second latency contract.

test('invalid UTF8 omits only its line and deep unsupported JSON does not stop siblings', () => {
  const deep = '['.repeat(66) + '0' + ']'.repeat(66)
  const input = Buffer.concat([
    encode({ text: 'first' }),
    Buffer.from('\n'),
    Buffer.from([0xff]),
    Buffer.from('\n' + deep + '\n'),
    encode({ text: 'last' }),
  ])
  const result = codexCaptureAdapter.prepareEvidence('transcript', input, createSanitizer([]))
  expect(
    new TextDecoder()
      .decode(result.bytes)
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line)),
  ).toEqual([
    { text: 'first' },
    { type: 'factory_omission', reason: 'unsupported-text' },
    { type: 'factory_omission', reason: 'unsupported-text' },
    { text: 'last' },
  ])
})

test('sensitive native identities are omitted rather than redirected', () => {
  const sanitizer = createSanitizer(['VALUE=synthetic-private-value'])
  for (const [adapter, kind, value] of [
    [
      codexCaptureAdapter,
      'transcript',
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'synthetic-private-value',
          output: 'answer',
        },
      },
    ],
    [
      claudeCaptureAdapter,
      'transcript',
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'synthetic-private-value', content: 'answer' },
          ],
        },
      },
    ],
    [
      claudeCaptureAdapter,
      'hook',
      {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'synthetic-private-value',
        tool_response: { stdout: 'answer' },
      },
    ],
  ] as const) {
    const result = adapter.prepareEvidence(kind, encode(value), sanitizer)
    expect(decode(result.bytes)).toEqual({ type: 'factory_omission', reason: 'sensitive-path' })
    expect(result.transformation.redacted).toBe(true)
  }
})

test('malformed and colliding transcript lines are fixed omissions at the same ordinal', () => {
  const input = [
    JSON.stringify({ type: 'future_codex_record', text: 'readable' }),
    '{"secret":"synthetic-private-value"',
    JSON.stringify({ 'synthetic-private-value': 1, '[REDACTED]': 2 }),
    JSON.stringify({ text: 'sibling' }),
  ].join('\n')
  const prepared = codexCaptureAdapter.prepareEvidence(
    'transcript',
    new TextEncoder().encode(input),
    createSanitizer(['VALUE=synthetic-private-value']),
  )
  expect(
    new TextDecoder()
      .decode(prepared.bytes)
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line)),
  ).toEqual([
    { type: 'future_codex_record', text: 'readable' },
    { type: 'factory_omission', reason: 'malformed-record' },
    { type: 'factory_omission', reason: 'json-key-collision' },
    { text: 'sibling' },
  ])
  expect(prepared.transformation.omissionReasons).toEqual([
    'malformed-record',
    'json-key-collision',
  ])
})

test('hooks aggregate stdout stderr including the header and cross-field secret', () => {
  const header = '[Combined stdout and stderr]\n'
  const sanitizer = createSanitizer(['VALUE=synthetic-private-value'])
  const hook = {
    hook_event_name: 'PostToolUse',
    tool_use_id: 'tool-1',
    tool_input: { command: 'q'.repeat(5000) },
    tool_response: {
      stdout: 'synthetic-',
      stderr: 'private-value' + 'x'.repeat(4001 - header.length - 10),
      exit_code: 0,
    },
  }
  const prepared = claudeCaptureAdapter.prepareEvidence('hook', encode(hook), sanitizer)
  const response = decode(prepared.bytes)
  expect(response.tool_response).toEqual({
    stdout:
      header +
      '[REDACTED]' +
      'x'.repeat(3000 - header.length - 10) +
      '\n[Factory omitted 1 characters]\n' +
      'x'.repeat(1000),
    stderr: '',
    exit_code: 0,
  })
  expect(response.tool_input).toEqual(hook.tool_input)
  expect(prepared.transformation.omittedCharacters).toBe(1)
})

test('Claude text blocks share a budget and omit recognized attachments', () => {
  const prepared = claudeCaptureAdapter.prepareEvidence(
    'transcript',
    encode({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', data: 'private-encoded-image' } },
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [
              { type: 'text', text: 'synthetic-' },
              { type: 'text', text: 'private-value' + 'a'.repeat(4001) },
              { type: 'image', source: { data: 'private-result-image' } },
            ],
          },
        ],
      },
    }),
    createSanitizer(['VALUE=synthetic-private-value']),
  )
  const content = decode(prepared.bytes).message.content
  expect(content[0]).toEqual({ type: 'text', text: '[Factory omitted nontext attachment]' })
  expect(content[1].content).toEqual([
    {
      type: 'text',
      text:
        '[REDACTED]' + 'a'.repeat(2990) + '\n[Factory omitted 11 characters]\n' + 'a'.repeat(1000),
    },
  ])
  expect(prepared.transformation).toEqual({
    policy: 'evidence-sanitization-1',
    redacted: true,
    omittedCharacters: 11,
    omissionReasons: ['nontext-attachment'],
  })
  expect(new TextDecoder().decode(prepared.bytes)).not.toContain('private-')
})

test('Codex recognizes function outputs but leaves unknown records and arguments untrimmed', () => {
  const long = 'x'.repeat(4001)
  const records = [
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-1', output: long },
    },
    { type: 'response_item', payload: { type: 'function_call', arguments: long } },
    {
      type: 'future_codex_record',
      payload: { output: long, 'synthetic-private-value': 42, opaque: { password: 'tiny' } },
    },
  ]
  const prepared = codexCaptureAdapter.prepareEvidence(
    'transcript',
    new TextEncoder().encode(records.map(value => JSON.stringify(value)).join('\n')),
    createSanitizer(['VALUE=synthetic-private-value']),
  )
  const output = new TextDecoder()
    .decode(prepared.bytes)
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line))
  expect(output[0].payload).toEqual({
    type: 'function_call_output',
    call_id: 'call-1',
    output: 'x'.repeat(3000) + '\n[Factory omitted 1 characters]\n' + 'x'.repeat(1000),
  })
  expect(output[1]).toEqual(records[1])
  expect(output[2].payload).toEqual({
    output: long,
    '[REDACTED]': 42,
    opaque: { password: '[REDACTED]' },
  })
})

test('Claude user-wrapped results trim after redaction without shortening ordinary prose', () => {
  const secret = 'synthetic-private-value'
  const prose = 'p'.repeat(6000) + secret
  const result = 'a'.repeat(3100) + secret + '😀'.repeat(1100)
  const prepared = claudeCaptureAdapter.prepareEvidence(
    'transcript',
    encode({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: prose },
          { type: 'tool_result', tool_use_id: 'tool-1', content: result, is_error: false },
        ],
      },
    }),
    createSanitizer([`VALUE=${secret}`]),
  )
  const content = decode(prepared.bytes).message.content
  expect(content[0].text).toBe('p'.repeat(6000) + '[REDACTED]')
  expect(content[1]).toEqual({
    type: 'tool_result',
    tool_use_id: 'tool-1',
    is_error: false,
    content: 'a'.repeat(3000) + '\n[Factory omitted 210 characters]\n' + '😀'.repeat(1000),
  })
  expect(prepared.transformation).toEqual({
    policy: 'evidence-sanitization-1',
    redacted: true,
    omittedCharacters: 210,
    omissionReasons: [],
  })
})
