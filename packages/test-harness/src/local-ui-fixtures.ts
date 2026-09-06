import type { DecisionObservation, RecordId } from '@factory/contract'
import {
  presentDecisions,
  type DecisionObservationView,
  type UiReadySnapshot,
  type UiSnapshot,
} from '@factory/domain'

import { writerChoice } from './choice-fixtures'

const id = (prefix: string, digit: string) =>
  `${prefix}_${'0'.repeat(26 - digit.length)}${digit}` as RecordId
const at = (minute: number) => `2026-09-05T10:${String(minute).padStart(2, '0')}:00Z`

function ready(): UiReadySnapshot {
  return {
    schemaVersion: 1,
    state: 'ready',
    canonicalBranch: 'main',
    counts: {
      sessions: 0,
      turns: 0,
      pullRequests: 0,
      reviews: 0,
      pendingTriggers: 0,
      highPriorityDecisions: 0,
    },
    sessions: [],
    repositoryObservations: [],
    pullRequests: [],
    associations: [],
    triggers: [],
    reviews: [],
    decisions: presentDecisions({
      canonicalBranch: 'main',
      stateFingerprint: 'a'.repeat(64),
      lineages: [],
      diagnostics: [],
    }),
    unresolvedDisputes: [],
    diagnostics: [],
  }
}

function withSession(snapshot: UiReadySnapshot): UiReadySnapshot {
  return {
    ...snapshot,
    counts: { ...snapshot.counts, sessions: 2, turns: 3, pendingTriggers: 1 },
    sessions: [
      {
        sessionKey: 'checkout-redesign',
        provider: 'codex',
        nativeSessionId: 'codex-native-1492',
        firstObservedAt: at(1),
        active: true,
        turns: [
          {
            turnId: id('turn', '1'),
            capturedAt: at(3),
            branch: 'feature/checkout',
            repositoryObservationId: id('observation', '1'),
            evidenceWatermark: 14,
            eventCount: 14,
            transcriptCount: 8,
            limitations: [],
          },
          {
            turnId: id('turn', '2'),
            capturedAt: at(8),
            branch: 'feature/checkout',
            repositoryObservationId: id('observation', '2'),
            evidenceWatermark: 29,
            eventCount: 15,
            transcriptCount: 7,
            limitations: [
              {
                code: 'missing-transcript-range',
                detail: 'Provider transcript ended before Stop.',
              },
            ],
          },
        ],
      },
      {
        sessionKey: 'claude-follow-up',
        provider: 'claude',
        nativeSessionId: 'claude-native-77',
        firstObservedAt: at(9),
        active: false,
        turns: [
          {
            turnId: id('turn', '3'),
            capturedAt: at(10),
            branch: 'feature/checkout',
            repositoryObservationId: id('observation', '3'),
            evidenceWatermark: 9,
            eventCount: 9,
            transcriptCount: 5,
            limitations: [],
          },
        ],
      },
    ],
    repositoryObservations: [
      {
        observationId: id('observation', '2'),
        observedAt: at(8),
        branch: 'feature/checkout',
        detached: false,
        head: '7d81f3533be942f4c9a8d7ea5223baff1b4f2a91',
        changedPaths: 6,
        exact: true,
        limitations: [],
      },
    ],
    triggers: [
      {
        triggerId: id('trigger', '1'),
        sessionKey: 'checkout-redesign',
        turnId: id('turn', '2'),
        provider: 'codex',
        evidenceWatermark: 29,
        materialization: 'partial',
        coverage: 'pending',
        limitations: [
          {
            code: 'missing-transcript-range',
            detail: 'Readable evidence exists through watermark 26.',
          },
        ],
      },
    ],
  }
}

function withPullRequests(snapshot: UiReadySnapshot): UiReadySnapshot {
  return {
    ...snapshot,
    counts: { ...snapshot.counts, pullRequests: 2 },
    pullRequests: [
      {
        repositoryKey: `ghr_${'1'.repeat(64)}`,
        number: 42,
        observationId: id('pr-observation', '1'),
        observedAt: at(14),
        availability: 'available',
        completeness: 'complete',
        state: 'open',
        url: 'https://github.com/example/factory/pull/42',
        limitations: [],
      },
      {
        repositoryKey: `ghr_${'1'.repeat(64)}`,
        number: 43,
        observationId: id('pr-observation', '2'),
        observedAt: at(15),
        availability: 'available',
        completeness: 'partial',
        state: 'open',
        url: 'https://github.com/example/factory/pull/43',
        limitations: [
          {
            code: 'incomplete-pull-request-commits',
            detail: 'GitHub returned a bounded commit prefix.',
          },
        ],
      },
    ],
    associations: [
      {
        evidenceId: id('association', '1'),
        sessionKey: 'checkout-redesign',
        pullRequestObservationId: id('pr-observation', '1'),
        kind: 'head',
        authority: 'exact',
        repositoryIdentity: 'same',
        shas: ['7d81f3533be942f4c9a8d7ea5223baff1b4f2a91'],
        observedAt: at(14),
      },
    ],
  }
}

function withReviews(snapshot: UiReadySnapshot): UiReadySnapshot {
  return {
    ...snapshot,
    counts: { ...snapshot.counts, reviews: 2, pendingTriggers: 1 },
    triggers: [
      {
        triggerId: id('trigger', '1'),
        sessionKey: 'checkout-redesign',
        turnId: id('turn', '2'),
        provider: 'codex',
        evidenceWatermark: 29,
        materialization: 'partial',
        coverage: 'partial',
        limitations: [
          {
            code: 'missing-transcript-range',
            detail: 'Readable prefix was reviewed; the missing tail remains unsettled.',
          },
        ],
      },
      {
        triggerId: id('trigger', '2'),
        sessionKey: 'claude-follow-up',
        turnId: id('turn', '3'),
        provider: 'claude',
        evidenceWatermark: 9,
        materialization: 'complete',
        coverage: 'pending',
        limitations: [],
      },
    ],
    reviews: [
      {
        reviewId: id('review', '1'),
        subject: { kind: 'workspace', repositoryObservationId: id('observation', '2') },
        completedAt: at(20),
        disposition: 'partial',
        coverageEffect: 'reviewed-partial',
        coverageAccepted: false,
        limitations: [
          { code: 'missing-transcript-range', detail: 'One readable Session range ended early.' },
        ],
        choiceCount: 2,
        summary: {
          reviewed: 'Reviewed payment retries and durable evidence. <img src=x onerror=alert(1)>',
          evidence: [],
        },
      },
      {
        reviewId: id('review', '2'),
        subject: { kind: 'workspace', repositoryObservationId: id('observation', '3') },
        completedAt: at(22),
        disposition: 'failed',
        coverageEffect: 'reviewed-partial',
        coverageAccepted: false,
        failureReason: 'reviewer-timeout',
        limitations: [
          { code: 'invalid-review-output', detail: 'No semantic entry survived the timeout.' },
        ],
        choiceCount: 0,
      },
    ],
  }
}

function observation(
  digit: string,
  summary: string,
  branch: string,
  assertion: unknown,
): DecisionObservation {
  return {
    ...writerChoice,
    schemaVersion: 1,
    observationId: id('decision', digit),
    reviewId: id('review', digit),
    reviewEntryId: id('entry', digit),
    choiceKey: 'payments.idempotency',
    effect: 'assert',
    assertion: assertion as never,
    assertionFingerprint: digit.repeat(64),
    headline: summary,
    source: { kind: 'workspace', branch, exactSnapshot: true },
    confidence: 'high',
    observedAt: at(24 + Number(digit)),
  }
}

function decisionView(
  value: DecisionObservation,
  lifecycle: DecisionObservationView['lifecycle'],
  humanStatus: DecisionObservationView['humanStatus'],
  materiality: DecisionObservationView['materiality'],
  priority: DecisionObservationView['priority'],
  pendingFromObservationId?: RecordId,
): DecisionObservationView {
  return {
    observation: value,
    scope:
      value.source.kind === 'workspace' && value.source.branch === 'main'
        ? 'canonical'
        : 'proposal',
    lifecycle,
    humanStatus,
    materiality,
    priority,
    ...(pendingFromObservationId === undefined
      ? {}
      : { pendingReason: 'change', pendingFromObservationId }),
  }
}

function withDecisions(snapshot: UiReadySnapshot): UiReadySnapshot {
  const proposal = observation('1', 'Use a request-scoped retry key.', 'feature/checkout', {
    key: 'request',
  })
  const current = observation('2', 'Persist one idempotency key per payment attempt.', 'main', {
    key: 'payment-attempt',
  })
  const change = observation('3', 'Scope idempotency keys to the customer cart.', 'main', {
    key: 'cart',
  })
  return {
    ...snapshot,
    counts: { ...snapshot.counts, highPriorityDecisions: 1 },
    decisions: presentDecisions({
      canonicalBranch: 'main',
      actionHeadId: id('action', '1'),
      stateFingerprint: 'b'.repeat(64),
      lineages: [
        {
          choiceKey: 'payments.idempotency',
          currentObservationId: current.observationId,
          observations: [
            decisionView(proposal, 'proposal', 'unconfirmed', 'new', 'normal'),
            decisionView(current, 'canonical-current', 'confirmed', 'new', 'normal'),
            decisionView(
              change,
              'pending-supersession',
              'unconfirmed',
              'material-change',
              'high',
              current.observationId,
            ),
          ],
        },
      ],
      diagnostics: [],
    }),
    unresolvedDisputes: [],
  }
}

export type LocalUiFixture = { id: string; description: string; snapshot: UiSnapshot }

export function localUiFixtures(): readonly LocalUiFixture[] {
  const empty = ready()
  const active = withSession(ready())
  const prs = withPullRequests(withSession(ready()))
  const reviews = withReviews(withSession(ready()))
  const decisions = withDecisions(withReviews(withPullRequests(withSession(ready()))))
  return [
    { id: 'empty', description: 'initialized repository without evidence', snapshot: empty },
    { id: 'active-capture', description: 'active multi-harness Session capture', snapshot: active },
    {
      id: 'workspace-review',
      description: 'complete workspace review',
      snapshot: {
        ...reviews,
        reviews: reviews.reviews.slice(0, 1).map(item => ({
          ...item,
          disposition: 'complete',
          coverageEffect: 'settled',
          limitations: [],
        })),
      },
    },
    { id: 'exact-pr', description: 'exact PR association', snapshot: prs },
    {
      id: 'ambiguous-pr',
      description: 'partial PR without exact association',
      snapshot: { ...prs, associations: [] },
    },
    {
      id: 'partial-coverage',
      description: 'partial review with unsettled evidence',
      snapshot: reviews,
    },
    {
      id: 'failed-review',
      description: 'failed review and pending trigger',
      snapshot: { ...reviews, reviews: reviews.reviews.slice(1) },
    },
    {
      id: 'canonical-decisions',
      description: 'confirmed canonical decision and pending change',
      snapshot: decisions,
    },
    {
      id: 'detached-head',
      description: 'detached Git observation',
      snapshot: {
        ...active,
        repositoryObservations: active.repositoryObservations.map(item => ({
          ...item,
          branch: null,
          detached: true,
        })),
      },
    },
    {
      id: 'github-unavailable',
      description: 'durable unavailable GitHub observation',
      snapshot: {
        ...prs,
        pullRequests: prs.pullRequests.map(item => ({
          ...item,
          availability: 'unavailable',
          completeness: 'unavailable',
          state: 'unavailable',
          url: undefined,
          limitations: [
            { code: 'unavailable-pull-request', detail: 'GitHub CLI is not authenticated.' },
          ],
        })),
      },
    },
    {
      id: 'corrupt-data',
      description: 'read-only corrupt repository state',
      snapshot: {
        schemaVersion: 1,
        state: 'corrupt',
        title: 'Factory data is unreadable',
        message:
          'Factory could not validate this repository evidence. No actions are available until the data is repaired.',
      },
    },
    {
      id: 'upgrade-required',
      description: 'read-only version gate',
      snapshot: {
        schemaVersion: 1,
        state: 'upgrade-required',
        title: 'Factory upgrade required',
        message:
          'This repository requires a newer Factory reader. Upgrade Factory before opening it.',
      },
    },
  ]
}
