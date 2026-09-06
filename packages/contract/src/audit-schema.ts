import type { JsonValue } from './index'

const text = { type: 'string', minLength: 1, maxLength: 16384 } as const
export const choiceAuditProperties = {
  choiceKey: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$' },
  effect: { type: 'string', enum: ['assert', 'remove', 'contradict'] },
  assertion: {},
  when: text,
  headline: { ...text, maxLength: 1024, pattern: '^[^\\r\\n]+$' },
  scenario: text,
  gap: text,
  reach: text,
  verdict: { type: 'string', enum: ['sound', 'unsound', 'needs-user'] },
  rationale: text,
  confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  evidence: {},
}
export const auditSummaryProperties = {
  reviewed: text,
  trivialDiscretionCount: { type: 'integer', minimum: 0 },
  noChoiceRationale: text,
  evidence: {},
}
export const auditSummaryRequired = ['reviewed', 'evidence']
export const auditVerdictFields: Readonly<Record<string, readonly string[]>> = {
  sound: [],
  unsound: ['correctedDecision'],
  'needs-user': ['provisionalCall', 'reversal'],
}

/** Describe the shared semantic fields while the caller supplies its citation locator schema. */
export function choiceAuditInputSchema(citation: JsonValue): JsonValue {
  const evidence = { type: 'array', minItems: 1, maxItems: 128, items: citation }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...choiceAuditProperties,
      evidence,
      correctedDecision: text,
      provisionalCall: text,
      reversal: text,
    },
    required: Object.keys(choiceAuditProperties),
    allOf: [
      {
        if: { properties: { verdict: { const: 'unsound' } } },
        then: { required: ['correctedDecision'] },
        else: { not: { required: ['correctedDecision'] } },
      },
      {
        if: { properties: { verdict: { const: 'needs-user' } } },
        then: { required: ['provisionalCall', 'reversal'] },
        else: { not: { anyOf: [{ required: ['provisionalCall'] }, { required: ['reversal'] }] } },
      },
      {
        if: { properties: { effect: { const: 'remove' } } },
        then: { properties: { assertion: { type: 'null' } } },
        else: { properties: { assertion: { not: { type: 'null' } } } },
      },
    ],
  }
}
export function auditSummaryInputSchema(citation: JsonValue): JsonValue {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...auditSummaryProperties,
      evidence: { type: 'array', minItems: 1, maxItems: 128, items: citation },
    },
    required: auditSummaryRequired,
  }
}
