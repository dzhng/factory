import assert from 'node:assert/strict'

import { createSanitizer } from '@factory/sanitization'

const sanitizer = createSanitizer(['TOKEN=fixture-secret', 'PASSWORD=abc'])
const reasoning = 'Keep the implementation decision; replace fixture-secret.'
const result = sanitizer.toolResult([
  'Relevant context. ' + 'a'.repeat(3100),
  'fixture-secret',
  'z'.repeat(1100) + ' Relevant tail.',
])
assert.equal(
  sanitizer.text(reasoning).text,
  'Keep the implementation decision; replace [REDACTED].',
)
assert.equal(result.text.includes('fixture-secret'), false)
assert.ok(result.omittedCharacters > 0)

const repetitive = createSanitizer(['TOKEN=' + 'a'.repeat(1000)])
const start = performance.now()
assert.equal(repetitive.text('a'.repeat(1_000_000)).text, '[REDACTED]')
assert.equal(repetitive.text('token'.repeat(200_000)).redacted, false)
assert.equal(repetitive.text('-----BEGIN PRIVATE KEY-----'.repeat(20_000)).text, '[REDACTED]')
const elapsedMs = Math.round(performance.now() - start)
assert.ok(elapsedMs < 5000, 'synthetic repetitive-input probe exceeded its work budget')

console.log(
  JSON.stringify(
    {
      authority: 'pure synthetic policy probe; no repository or provider data read',
      reasoning: sanitizer.text(reasoning).text,
      toolResult: result,
      repetitiveInput: { bytes: 2_540_000, elapsedMs, budgetMs: 5000 },
    },
    null,
    2,
  ),
)
