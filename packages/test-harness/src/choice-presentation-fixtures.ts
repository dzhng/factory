import { presentDecisions, type DecisionView, type UiReadySnapshot } from '@factory/domain'

import { writerChoice } from './choice-fixtures'
import { localUiFixtures } from './local-ui-fixtures'

export function presentationDecisions(): DecisionView {
  const original = {
    humanStatus: 'unconfirmed' as const,
    materiality: 'new' as const,
    observation: {
      ...writerChoice,
      schemaVersion: 1 as const,
      observationId: 'decision_00000000000000000000000001' as const,
      reviewId: 'review_00000000000000000000000001' as const,
      reviewEntryId: 'entry_00000000000000000000000001' as const,
      assertionFingerprint: '1'.repeat(64),
      source: { kind: 'workspace' as const, branch: 'main', exactSnapshot: true },
      observedAt: '2026-09-05T10:25:00Z',
    },
  }
  const choices = [
    {
      headline: 'Keep payment receipts for one year',
      verdict: 'needs-user',
      confidence: 'low',
      scenario:
        'When a customer asks for an old receipt, support reads the saved payment record. The agent chose to keep that record for one year. Keeping it indefinitely would help with older requests, but would also retain customer data longer and increase storage costs.',
      gap: 'The request did not set a retention period or authorize the ongoing storage cost.',
      reach:
        'Every future receipt lookup and scheduled deletion will inherit this retention window.',
      provisionalCall: 'Keep receipts for 90 days while the owner chooses a retention policy.',
      reversal:
        'Change the retention setting before the first scheduled deletion; export any records that must be kept.',
    },
    {
      headline: 'Use email for failed-payment notifications',
      verdict: 'needs-user',
      confidence: 'medium',
      scenario:
        'When a payment fails, the customer receives an email explaining how to retry. The agent selected email instead of an in-app notice. Email reaches customers who have closed the app, but adds a third-party delivery cost.',
      gap: 'The requested payment flow did not select a notification channel.',
      reach: 'Future payment retries rely on the selected delivery service.',
      provisionalCall: 'Keep the in-app notice and leave email delivery disabled.',
      reversal: 'Enable email delivery after the owner approves its cost.',
    },
    {
      headline: 'Create a fresh retry key for every network attempt',
      verdict: 'unsound',
      confidence: 'low',
      scenario:
        'A payment can succeed even when its response is lost. The client retries the request with a new key, so the server treats it as a second payment. Reusing one key for the same payment lets the server return the first result without charging again.',
      gap: 'The request asked for retries without specifying how repeated requests identify the same payment.',
      reach: 'Every slow or interrupted payment can become a duplicate charge.',
      correctedDecision:
        'One logical payment must keep the same idempotency key across all network retries.',
    },
    {
      headline: 'Use one repository writer for immutable records',
      verdict: 'sound',
      confidence: 'high',
      scenario:
        'When two workers publish a review, both ask the repository writer to create immutable records. The writer refuses a different value at an existing path. Letting each worker write files directly would duplicate this rule and make crash recovery harder to reason about.',
      gap: 'The implementation request did not assign ownership of file publication.',
      reach: 'Future producers can share one publication rule rather than reimplement it.',
    },
    {
      headline: 'Retire the browser-local receipt cache',
      verdict: 'sound',
      confidence: 'medium',
      effect: 'remove',
      scenario:
        'Receipts now come from the server on every lookup. The old browser cache is explicitly removed, so switching accounts cannot show a receipt left behind by the previous account. This observation records removal rather than inferring it from a review that says nothing about caching.',
      gap: 'The earlier implementation had introduced a cache without a requested lifetime.',
      reach: 'New receipt screens must not depend on the retired browser cache.',
    },
  ] as const
  return {
    canonicalBranch: 'main',
    stateFingerprint: 'b'.repeat(64),
    diagnostics: [],
    lineages: choices.map((choice, index) => ({
      choiceKey: `presentation.choice-${index}`,
      observations: [
        {
          ...original,
          scope: index === 1 ? 'proposal' : 'canonical',
          lifecycle: 'effect' in choice ? 'removed' : 'proposal',
          priority: choice.verdict === 'sound' ? 'normal' : 'high',
          observation: {
            ...original.observation,
            ...choice,
            choiceKey: `presentation.choice-${index}`,
            effect: 'effect' in choice ? 'remove' : 'assert',
            assertion: 'effect' in choice ? null : { choice: index },
            observationId: `decision_${String(index + 10).padStart(26, '0')}`,
            reviewEntryId: `entry_${String(index + 10).padStart(26, '0')}`,
            rationale:
              choice.verdict === 'sound'
                ? 'The decision keeps one clear source of authority.'
                : choice.verdict === 'unsound'
                  ? 'Retries must not change the identity of the payment.'
                  : 'The owner must choose the cost and customer-data tradeoff.',
          },
        },
      ],
    })),
  }
}

export function choicePresentationFixture(): UiReadySnapshot {
  const baseline = localUiFixtures().find(fixture => fixture.id === 'canonical-decisions')!
    .snapshot as UiReadySnapshot
  return {
    ...baseline,
    decisions: presentDecisions(presentationDecisions()),
    counts: { ...baseline.counts, reviews: 3, highPriorityDecisions: 3 },
    reviews: [
      ...baseline.reviews,
      {
        ...baseline.reviews[0]!,
        reviewId: 'review_00000000000000000000000009',
        completedAt: '2026-09-05T10:30:00Z',
        disposition: 'complete',
        coverageEffect: 'settled',
        limitations: [],
        choiceCount: 0,
        summary: {
          reviewed:
            'Reviewed the receipt query, the requested retention setting, and the prior choice ledger.',
          noChoiceRationale:
            'Every remaining implementation decision was explicitly requested by the owner or delegated by the spec; no undeclared choice was found.',
          trivialDiscretionCount: 2,
          evidence: writerChoice.evidence.map(item => ({
            role: item.object.role,
            digest: item.object.sha256,
          })),
        },
      },
    ],
  }
}
