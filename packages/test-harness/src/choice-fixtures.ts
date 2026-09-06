import {
  canonicalJson,
  type AuditEvidence,
  type ChoiceAuditSubmission,
  type ChoiceAuditSummary,
} from '@factory/contract'

/** Synthetic writer-ownership decision used by publication and replay fixtures. */
export const writerChoice: ChoiceAuditSubmission & { verdict: 'sound' } = {
  choiceKey: 'repository.writer',
  effect: 'assert',
  assertion: { owner: 'repository' },
  when: 'When durable review publication was implemented',
  headline: 'Repository owns durable writes',
  scenario:
    'A review finishes and publishes several related records. The repository writer makes the manifest visible last, so a crash cannot expose half a review. Separate writers would each need to coordinate that recovery rule.',
  gap: 'The task required durable reviews without assigning one publication owner.',
  reach: 'New analyzers and providers must publish through the repository boundary.',
  verdict: 'sound',
  rationale: 'One publication owner gives every caller the same recovery guarantee.',
  confidence: 'high',
  evidence: [
    {
      object: {
        algorithm: 'sha256',
        sha256: 'a'.repeat(64),
        bytes: 1,
        mediaType: 'text/plain',
        role: 'synthetic-evidence',
      },
    },
  ],
}

export function emptyAuditSummary(
  evidence: AuditEvidence,
  reviewed = 'Inspected the synthetic implementation session and its explicit specification.',
): ChoiceAuditSummary {
  return {
    reviewed,
    noChoiceRationale:
      'The specification explicitly selected the observed behavior; the implementation introduced no additional undeclared decision.',
    evidence,
  }
}

export function summarySubmissions(evidence: AuditEvidence, reviewed?: string): string {
  return (
    canonicalJson({ kind: 'audit-summary', summary: emptyAuditSummary(evidence, reviewed) }) +
    canonicalJson({ kind: 'finish' })
  )
}

export function checkpointChoices(evidence: AuditEvidence): ChoiceAuditSubmission[] {
  return [
    { ...writerChoice, choiceKey: 'storage.owner', evidence },
    {
      ...writerChoice,
      choiceKey: 'retry.limit',
      assertion: { retryDeadline: null },
      headline: 'Retry failed reviews without a deadline',
      when: 'When transient reviewer failures were handled',
      scenario:
        'The model service is unavailable and a review retries forever. The command never returns and occupies the review slot. A finite deadline would preserve the captured evidence and let the developer retry after the service recovers.',
      gap: 'The request asked for retrying transient errors but did not set a stopping condition.',
      reach: 'Every unattended review can otherwise remain active indefinitely.',
      verdict: 'unsound',
      confidence: 'high',
      rationale: 'Retries must stop when they cannot make progress.',
      correctedDecision: 'Every retry sequence must have a finite deadline.',
      evidence,
    },
    {
      ...writerChoice,
      choiceKey: 'hosting.region',
      assertion: { region: 'existing' },
      headline: 'Keep review hosting in the existing region',
      when: 'When hosted review deployment was configured',
      scenario:
        'A customer in another region starts a review. Using the existing region keeps deployment simple but may increase latency and place their data outside their preferred location. A deployment near that customer changes cost and data location.',
      gap: 'The request did not specify data location or the acceptable cost of another deployment.',
      reach: 'Future hosted customers inherit this data-location and latency decision.',
      verdict: 'needs-user',
      confidence: 'low',
      rationale: 'Customer geography, budget, and data-location preferences belong to the user.',
      provisionalCall: 'Use the existing region for synthetic traffic temporarily.',
      reversal: 'Select and deploy the agreed region before admitting customer traffic.',
      evidence,
    },
  ]
}
