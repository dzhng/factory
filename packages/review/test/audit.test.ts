import { describe, expect, test } from 'bun:test'

import { canonicalJson, type ChoiceAuditSubmission, type ObjectRef } from '@factory/contract'
import { acceptAuditDraft, readAuditDraft } from '@factory/contract'

const object: ObjectRef = {
  algorithm: 'sha256',
  sha256: 'a'.repeat(64),
  bytes: 10,
  mediaType: 'text/plain',
  role: 'evidence',
}
const reviewId = 'review_00000000000000000000000001' as const
const choice: ChoiceAuditSubmission = {
  choiceKey: 'capture.owner',
  effect: 'assert',
  assertion: { writer: 'repository' },
  when: 'When capture persistence was introduced',
  headline: 'One owner publishes capture',
  scenario:
    'A provider hook finishes a turn. The repository writer publishes its evidence, so recovery follows one commit rule. Letting each hook write would require two recovery protocols.',
  gap: 'The request did not assign publication ownership.',
  reach: 'Every new provider uses the same publication boundary.',
  verdict: 'sound',
  rationale: 'One owner keeps interrupted publication recoverable.',
  confidence: 'high',
  evidence: [{ object }],
}
const summary = {
  reviewed: 'Read the capture session, its specification, and the prior ledger.',
  evidence: [{ object }],
}
const submit = { kind: 'choice', choice }
const finish = { kind: 'finish' }

describe('choice audit submissions', () => {
  test('snapshots caller-owned nested submission data before deriving immutable identities', () => {
    const mutable = JSON.parse(JSON.stringify(submit))
    const accepted = acceptAuditDraft([mutable], [object], reviewId)
    mutable.choice.assertion.writer = 'hook'
    mutable.choice.evidence[0].object.role = 'forged'
    expect(accepted.entries[0]?.assertion).toEqual({ writer: 'repository' })
    expect(accepted.entries[0]?.evidence[0]?.object).toEqual(object)
  })
  test('bounds the derived ledger as well as the submitted event bytes', () => {
    const events = Array.from({ length: 500 }, (_, index) => ({
      kind: 'choice',
      choice: { ...choice, choiceKey: `choice-${index}`, scenario: 's'.repeat(1500) },
    }))
    const accepted = acceptAuditDraft(events, [object], reviewId)
    const ledger = { schemaVersion: 1, reviewId, entries: accepted.entries }
    expect(Buffer.byteLength(canonicalJson(ledger))).toBeLessThanOrEqual(1024 * 1024)
    expect(accepted.entries[0]?.assertion).toEqual(choice.assertion)
    expect(accepted.incomplete).toBeTrue()
  })
  test('rejects missing verdict decisions and unexpected verdict fields while keeping independent valid entries', () => {
    const parsed = acceptAuditDraft(
      [
        { kind: 'choice', choice: { ...choice, choiceKey: 'retry', verdict: 'unsound' } },
        {
          kind: 'choice',
          choice: {
            ...choice,
            choiceKey: 'region',
            verdict: 'needs-user',
            provisionalCall: 'Stay local',
          },
        },
        {
          kind: 'choice',
          choice: { ...choice, choiceKey: 'scope', correctedDecision: 'Unexpected' },
        },
        submit,
        { kind: 'audit-summary', summary },
        finish,
      ],
      [object],
      reviewId,
    )
    expect(parsed.entries.map(entry => entry.choiceKey)).toEqual(['capture.owner'])
    expect(parsed.incomplete).toBeTrue()
  })

  test('requires a cited explicit rationale to complete an audit with no choices', () => {
    const missing = acceptAuditDraft(
      [{ kind: 'audit-summary', summary }, finish],
      [object],
      reviewId,
    )
    expect(missing.incomplete).toBeTrue()
    expect(missing.summary).toEqual(summary)
    const explained = {
      ...summary,
      noChoiceRationale:
        'The user chose the storage owner and explicitly delegated internal helper naming; no other implementation choice was found.',
    }
    const complete = acceptAuditDraft(
      [{ kind: 'audit-summary', summary: explained }, finish],
      [object],
      reviewId,
    )
    expect(complete).toMatchObject({ entries: [], summary: explained, incomplete: false })
  })

  test('exact retries reuse entries and conflicting choice meanings never overwrite the first submission', () => {
    const once = acceptAuditDraft(
      [submit, { kind: 'audit-summary', summary }, finish],
      [object],
      reviewId,
    )
    const retry = acceptAuditDraft(
      [
        submit,
        submit,
        { kind: 'audit-summary', summary },
        { kind: 'audit-summary', summary },
        finish,
        finish,
      ],
      [object],
      reviewId,
    )
    expect(retry).toEqual(once)
    const conflict = acceptAuditDraft(
      [submit, { kind: 'choice', choice: { ...choice, assertion: { writer: 'hook' } } }],
      [object],
      reviewId,
    )
    expect(conflict.entries).toEqual(once.entries)
    expect(conflict.incomplete).toBeTrue()
    expect(new TextDecoder().decode(conflict.submissions)).not.toContain('"writer":"hook"')
  })

  test('preserves exact citation authority and valid submissions before malformed tails', () => {
    const raw = new TextEncoder().encode(canonicalJson(submit) + '{broken')
    const parsed = readAuditDraft(raw, [object], reviewId)
    expect(parsed.entries[0]).toMatchObject(choice)
    expect(parsed.incomplete).toBeTrue()
    expect(new TextDecoder().decode(parsed.submissions)).toBe(canonicalJson(submit))
    const forged = acceptAuditDraft(
      [
        {
          kind: 'choice',
          choice: { ...choice, evidence: [{ object: { ...object, role: 'forged' } }] },
        },
      ],
      [object],
      reviewId,
    )
    expect(forged.entries).toEqual([])
  })

  test('requires null exactly for explicit removal and never infers removal from silence', () => {
    const removed = acceptAuditDraft(
      [{ kind: 'choice', choice: { ...choice, effect: 'remove', assertion: null } }],
      [object],
      reviewId,
    )
    expect(removed.entries[0]).toMatchObject({
      choiceKey: choice.choiceKey,
      effect: 'remove',
      assertion: null,
    })
    for (const invalid of [
      { effect: 'remove', assertion: {} },
      { effect: 'assert', assertion: null },
      { effect: 'contradict', assertion: null },
    ]) {
      expect(
        acceptAuditDraft(
          [{ kind: 'choice', choice: { ...choice, ...invalid } }],
          [object],
          reviewId,
        ).entries,
      ).toEqual([])
    }
    expect(acceptAuditDraft([], [object], reviewId).entries).toEqual([])
  })
})
