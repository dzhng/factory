import {
  canonicalJson,
  readAuditDraft,
  type AuditEvidence,
  type ChoiceAuditEvent,
  type ObjectRef,
  type RecordId,
  type EvidenceTransformation,
} from '@factory/contract'
import { SanitizationError, type createSanitizer } from '@factory/sanitization'

export type ReviewSanitizer = ReturnType<typeof createSanitizer>

/** Prepare only accepted semantic events; invalid tails never acquire publication authority. */
export function prepareAuditDraft(
  submissions: Uint8Array,
  inventory: readonly ObjectRef[],
  reviewId: RecordId,
  sanitizer: ReviewSanitizer,
) {
  const original = readAuditDraft(submissions, inventory, reviewId)
  const events: ChoiceAuditEvent[] = []
  const omissionReasons = new Set<EvidenceTransformation['omissionReasons'][number]>()
  let redacted = false
  const text = (value: string) => {
    const result = sanitizer.text(value)
    redacted ||= result.redacted
    return result.text
  }
  const evidence = (values: AuditEvidence) => {
    for (const citation of values) {
      if (citation.locator !== undefined && sanitizer.text(citation.locator).redacted)
        throw new SanitizationError('unsupported-content')
    }
    return values
  }
  for (const line of Buffer.from(original.submissions).toString().trimEnd().split('\n')) {
    if (!line) continue
    const event = JSON.parse(line) as ChoiceAuditEvent
    try {
      if (event.kind === 'choice') {
        const value = event.choice
        if (sanitizer.text(value.choiceKey).redacted)
          throw new SanitizationError('unsupported-content')
        const assertion =
          value.effect === 'remove'
            ? { value: null, redacted: false }
            : sanitizer.json(value.assertion)
        redacted ||= assertion.redacted
        events.push({
          kind: 'choice',
          choice: {
            ...value,
            assertion: assertion.value,
            when: text(value.when),
            headline: text(value.headline),
            scenario: text(value.scenario),
            gap: text(value.gap),
            reach: text(value.reach),
            rationale: text(value.rationale),
            evidence: evidence(value.evidence),
            ...(value.verdict === 'unsound'
              ? { correctedDecision: text(value.correctedDecision) }
              : {}),
            ...(value.verdict === 'needs-user'
              ? { provisionalCall: text(value.provisionalCall), reversal: text(value.reversal) }
              : {}),
          },
        })
      } else if (event.kind === 'audit-summary') {
        events.push({
          kind: 'audit-summary',
          summary: {
            ...event.summary,
            reviewed: text(event.summary.reviewed),
            evidence: evidence(event.summary.evidence),
            ...(event.summary.noChoiceRationale === undefined
              ? {}
              : { noChoiceRationale: text(event.summary.noChoiceRationale) }),
          },
        })
      } else events.push(event)
    } catch (error) {
      if (!(error instanceof SanitizationError) || error.code === 'sanitization-limit') throw error
      omissionReasons.add(
        error.code === 'json-key-collision' ? 'json-key-collision' : 'sensitive-path',
      )
    }
  }
  const prepared = readAuditDraft(
    Buffer.from(events.map(canonicalJson).join('')),
    inventory,
    reviewId,
  )
  return {
    ...prepared,
    incomplete: original.incomplete || omissionReasons.size > 0 || prepared.incomplete,
    redacted,
    omissionReasons: [...omissionReasons].sort(),
  }
}
