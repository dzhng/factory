import type { JsonValue } from './index'

const text = { type: 'string', minLength: 1, maxLength: 16384 } as const
export const choiceAuditProperties = {
  choiceKey: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$' },
  effect: { type: 'string', enum: ['assert', 'remove', 'contradict'] },
  assertion: {
    description:
      'Structured observed meaning. Null only for remove; assert and contradict require a non-null JSON value.',
  },
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

/** Flat schemas remain usable by provider clients; the shared validator enforces conditional rules. */
export function choiceAuditInputSchema(citation: JsonValue): JsonValue {
  const evidence = { type: 'array', minItems: 1, maxItems: 128, items: citation }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...choiceAuditProperties,
      evidence,
      correctedDecision: {
        ...text,
        description: 'Required only for unsound: the corrected decision to redo from.',
      },
      provisionalCall: {
        ...text,
        description: 'Required only for needs-user: a reversible provisional call.',
      },
      reversal: {
        ...text,
        description: 'Required only for needs-user: how to reverse the provisional call.',
      },
    },
    required: Object.keys(choiceAuditProperties),
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
