import { expect, test } from 'bun:test'

import { createSanitizer, discoverSanitizer } from '../src/index'

test('repository values redact literally while short ordinary values remain useful', () => {
  const sanitizer = createSanitizer(['HOST=localhost\nPORT=3000\nPASSWORD=abc\nEMPTY='])
  expect(sanitizer.text('Connect localhost:3000 using abc.')).toEqual({
    text: 'Connect [REDACTED]:3000 using [REDACTED].',
    redacted: true,
  })
  expect(sanitizer.text('Keep this reasoning.')).toEqual({
    text: 'Keep this reasoning.',
    redacted: false,
  })
})

test('resource exhaustion refuses preparation rather than building an unbounded dictionary', () => {
  expect(() => createSanitizer(['TOKEN=' + 'x'.repeat(600_000)])).toThrow('sanitization-limit')
  expect(() => {
    createSanitizer(['TOKEN=a']).text('a '.repeat(210_000))
  }).toThrow('sanitization-limit')
  expect(createSanitizer(['TOKEN=a']).text('a'.repeat(1_000_000)).text).toBe('[REDACTED]')
})

test('discovery builds an ephemeral matcher and closes filesystem/decode failures', async () => {
  const sanitizer = await discoverSanitizer(async () => [
    new TextEncoder().encode('TOKEN=synthetic-discovery-value'),
  ])
  expect(sanitizer.text('synthetic-discovery-value').text).toBe('[REDACTED]')
  await expect(
    discoverSanitizer(async () => {
      throw new Error('secret filesystem path')
    }),
  ).rejects.toThrow('discovery-unavailable')
  await expect(discoverSanitizer(async () => [new Uint8Array([255])])).rejects.toThrow(
    'discovery-unavailable',
  )
})

test('an incomplete private-key block cannot retain its sensitive tail', () => {
  expect(
    createSanitizer([]).text('reason\n-----BEGIN RSA PRIVATE KEY-----\nsecret tail').text,
  ).toBe('reason\n[REDACTED]')
})

test('tool-result budget is shared across blocks and counts Unicode after redaction', () => {
  const sanitizer = createSanitizer(['TOKEN=' + 's'.repeat(100)])
  for (const size of [3999, 4000]) {
    const input = '🙂'.repeat(size)
    expect(sanitizer.toolResult([input])).toEqual({
      text: input,
      redacted: false,
      omittedCharacters: 0,
    })
  }
  expect(sanitizer.toolResult(['🙂'.repeat(3000), 'X', 'Y'.repeat(1000)])).toEqual({
    text: '🙂'.repeat(3000) + '\n[Factory omitted 1 characters]\n' + 'Y'.repeat(1000),
    redacted: false,
    omittedCharacters: 1,
  })
  expect(
    sanitizer.toolResult(['a'.repeat(2900) + 's'.repeat(50), 's'.repeat(50) + 'b'.repeat(1090)]),
  ).toEqual({
    text: 'a'.repeat(2900) + '[REDACTED]' + 'b'.repeat(1090),
    redacted: true,
    omittedCharacters: 0,
  })
  expect(sanitizer.text('reasoning '.repeat(1000)).text).toBe('reasoning '.repeat(1000))
})

test('JSON sanitizes decoded values and keys and refuses colliding redacted keys', () => {
  const sanitizer = createSanitizer(['VALUE=fixture-secret'])
  expect(
    sanitizer.json(
      JSON.parse('{"fixture-secret":{"text":"fixture-\\u0073ecret","password":"short"}}'),
    ),
  ).toEqual({
    value: { '[REDACTED]': { text: '[REDACTED]', password: '[REDACTED]' } },
    redacted: true,
  })
  expect(() => sanitizer.json({ 'fixture-secret': 1, '[REDACTED]': 2 })).toThrow(
    'json-key-collision',
  )
})

test('opaque JSON numeric credentials are sanitized rather than treated as structural IDs', () => {
  const sanitizer = createSanitizer(['TOKEN=12345678'])
  expect(sanitizer.json({ pin: 12345678, password: 1234, count: 2 }).value).toEqual({
    pin: '[REDACTED]',
    password: '[REDACTED]',
    count: 2,
  })
})

test('recognizable credentials redact without treating ordinary hashes as credentials', () => {
  const sanitizer = createSanitizer([])
  const key = 'sk-proj-' + 'Z8'.repeat(24)
  expect(
    sanitizer.text(`use ${key}; Authorization: Bearer abc.def-ghi; api_key="secret-value"`).text,
  ).toBe('use [REDACTED]; Authorization: Bearer [REDACTED]; api_key="[REDACTED]"')
  expect(sanitizer.text('commit ' + 'a1'.repeat(20)).redacted).toBe(false)
  expect(
    sanitizer.text('-----BEGIN PRIVATE KEY-----\nsynthetic content\n-----END PRIVATE KEY-----')
      .text,
  ).toBe('[REDACTED]')
})

test('quoted credential assignments redact the entire value including punctuation and escaped quotes', () => {
  const sanitizer = createSanitizer([])
  for (const value of ['correct horse battery staple', 'abc;def', 'abc,def', 'abc\\"def']) {
    expect(sanitizer.text(`password="${value}"; retain context`).text).toBe(
      'password="[REDACTED]"; retain context',
    )
  }
  expect(sanitizer.text("secret='hello\nworld'!").text).toBe("secret='[REDACTED]'!")
})

test('replacement is simultaneous and overlapping secrets cannot expose surviving fragments', () => {
  const sanitizer = createSanitizer(['TOKEN=abc\nPASSWORD=bcde\nSECRET=REDACTED'])
  expect(sanitizer.text('abcde [REDACTED] REDACTED').text).toBe('[REDACTED] [REDACTED] [REDACTED]')
})

test('dotenv parsing retains duplicate assignments and quoted multiline values without execution', () => {
  const sanitizer = createSanitizer([
    `# config\nexport TOKEN = 'first token # literal'\nTOKEN="second\\nline" # comment\nTOKEN='$(touch /tmp/not-executed)'\nKEY="a real\nmultiline value"`,
  ])
  expect(
    sanitizer.text(
      'first token # literal; second\nline; $(touch /tmp/not-executed); a real\nmultiline value',
    ).text,
  ).toBe('[REDACTED]; [REDACTED]; [REDACTED]; [REDACTED]')
  expect(() => createSanitizer(['TOKEN="unfinished'])).toThrow('invalid-env')
  expect(sanitizer.text('copied value: second\\nline').text).toBe('copied value: [REDACTED]')
})
