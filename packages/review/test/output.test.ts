import { describe, expect, test } from 'bun:test'

import type { ObjectRef } from '@factory/contract'

import { parseSemanticOutput } from '../src/output'

const object: ObjectRef = {
  algorithm: 'sha256',
  sha256: 'a'.repeat(64),
  bytes: 12,
  mediaType: 'text/plain',
  role: 'event-raw',
}

describe('review semantic output', () => {
  test('keeps a cited prefix and marks a malformed tail incomplete', () => {
    const valid = JSON.stringify({
      kind: 'finding',
      severity: 'high',
      summary: 'The change bypasses the boundary',
      evidence: [{ object, locator: 'line:12' }],
    })
    const parsed = parseSemanticOutput(
      new TextEncoder().encode(`${valid}\n{"kind":"finding"`),
      [object],
      'review_00000000000000000000000000',
    )

    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toMatchObject({
      kind: 'finding',
      severity: 'high',
      summary: 'The change bypasses the boundary',
      evidence: [{ object, locator: 'line:12' }],
    })
    expect(parsed.incomplete).toBe(true)
  })

  test('requires exact ObjectRef citation identity, not a matching hash alone', () => {
    const line = JSON.stringify({
      kind: 'summary',
      summary: 'Looks fine',
      evidence: [{ object: { ...object, role: 'invented-role' } }],
    })
    const parsed = parseSemanticOutput(
      new TextEncoder().encode(`${line}\n`),
      [object],
      'review_00000000000000000000000000',
    )
    expect(parsed).toMatchObject({ entries: [], incomplete: true })
  })

  test('keeps valid UTF-8 lines before an undecodable tail', () => {
    const valid = new TextEncoder().encode(
      `${JSON.stringify({ kind: 'summary', summary: 'Useful prefix', evidence: [{ object }] })}\n`,
    )
    const raw = new Uint8Array(valid.byteLength + 1)
    raw.set(valid)
    raw[raw.length - 1] = 0xff
    const parsed = parseSemanticOutput(raw, [object], 'review_00000000000000000000000000')
    expect(parsed.entries.map(entry => entry.summary)).toEqual(['Useful prefix'])
    expect(parsed.incomplete).toBe(true)
  })

  test('accepts a final valid JSON value without a newline', () => {
    const raw = new TextEncoder().encode(
      JSON.stringify({ kind: 'summary', summary: 'Complete response', evidence: [{ object }] }),
    )
    const parsed = parseSemanticOutput(raw, [object], 'review_00000000000000000000000000')
    expect(parsed.entries.map(entry => entry.summary)).toEqual(['Complete response'])
    expect(parsed.incomplete).toBe(false)
  })

  test('rejects blank and oversized semantic fields without losing valid siblings', () => {
    const lines = [
      {
        kind: 'decision',
        decisionKey: 'repository.single-writer',
        effect: 'assert',
        assertion: { owner: 'repository' },
        confidence: 'high',
        summary: 'Keep one writer',
        evidence: [{ object }],
      },
      { kind: 'summary', summary: ' ', evidence: [{ object }] },
      { kind: 'summary', summary: 'x'.repeat(16_385), evidence: [{ object }] },
    ]
    const parsed = parseSemanticOutput(
      new TextEncoder().encode(`${lines.map(line => JSON.stringify(line)).join('\n')}\n`),
      [object],
      'review_00000000000000000000000000',
    )
    expect(parsed.entries.map(entry => entry.summary)).toEqual(['Keep one writer'])
    expect(parsed.incomplete).toBe(true)
  })

  test('requires decision assertions exactly when the effect carries meaning', () => {
    const decisions = [
      { effect: 'assert', assertion: null },
      { effect: 'contradict', assertion: null },
      { effect: 'remove', assertion: { owner: 'repository' } },
    ].map((decision, index) => ({
      kind: 'decision',
      decisionKey: `decision-${index}`,
      ...decision,
      confidence: 'high',
      summary: 'Invalid decision shape',
      evidence: [{ object }],
    }))

    const parsed = parseSemanticOutput(
      new TextEncoder().encode(
        `${decisions.map(decision => JSON.stringify(decision)).join('\n')}\n`,
      ),
      [object],
      'review_00000000000000000000000000',
    )

    expect(parsed).toMatchObject({ entries: [], incomplete: true })
  })
})
