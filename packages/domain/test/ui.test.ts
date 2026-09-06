import { describe, expect, test } from 'bun:test'

import {
  canonicalJson,
  reviewSubjectCoverageId,
  type JsonValue,
  type RepositoryRecords,
  type RepositoryObservation,
  type ReviewLedger,
  type ReviewManifest,
} from '@factory/contract'

import { writerChoice, emptyAuditSummary } from '../../test-harness/src/choice-fixtures'
import { presentationDecisions } from '../../test-harness/src/choice-presentation-fixtures'
import { deriveDecisionObservations } from '../src/decisions'
import { buildUiProjection, presentDecisions } from '../src/ui'

const identity = {
  schemaVersion: 1,
  provider: 'codex',
  nativeSessionId: 'native-session',
  sessionKey: 'session-one',
  captureGeneration: 1,
  repositoryId: 'repo_ui',
  firstObservedAt: '2026-09-05T00:00:00Z',
} as const

const turn = {
  schemaVersion: 1,
  turnId: `turn_${'0'.repeat(25)}1`,
  sessionKey: identity.sessionKey,
  nativeStopId: 'stop-one',
  capturedAt: '2026-09-05T00:00:01Z',
  materializedAt: '2026-09-05T00:00:02Z',
  eventRange: { first: 1, last: 2 },
  transcriptObservations: [],
  evidenceObjects: [],
  branch: 'feature/ui',
  limitations: [],
  captureAdapterVersion: 'test',
  formatVersion: 1,
  inventory: [],
} as const

const assertion = { storage: 'append-only' } as const
const repositoryObservation: RepositoryObservation = {
  schemaVersion: 1,
  observationId: `observation_${'0'.repeat(25)}1`,
  repositoryId: 'repo_ui',
  observedAt: '2026-09-05T00:00:03Z',
  completedAt: '2026-09-05T00:00:04Z',
  git: { head: 'a'.repeat(40), branch: 'main', detached: false },
  changedPaths: [],
  worktreeFingerprint: 'a'.repeat(64),
  limitations: [],
  startState: 'b'.repeat(64),
  endState: 'b'.repeat(64),
}
const reviewId = `review_${'0'.repeat(25)}1` as const
const manifest: ReviewManifest = {
  schemaVersion: 1,
  reviewId,
  subject: { kind: 'workspace', repositoryObservationId: repositoryObservation.observationId },
  patches: [],
  sessionWatermarks: {},
  coverageTargetWatermarks: {},
  subjectFingerprint: 'c'.repeat(64),
  subjectAttempt: {
    fingerprint: 'c'.repeat(64),
    coverageId: reviewSubjectCoverageId('c'.repeat(64), []),
    effect: 'current-included',
    limitations: [],
  },
  evidenceSelections: [],
  inputProblems: [],
  triggerIds: [],
  associationBatchIds: [],
  limitations: [],
  reviewer: { provider: 'codex', model: 'test', effort: 'high' },
  analyzerVersion: 'test',
  promptVersion: 'test',
  policyVersion: 'test',
  formatVersion: 1,
  bundleSha256: 'e'.repeat(64),
  containerImageDigest: `sha256:${'f'.repeat(64)}`,
  providerCliVersion: 'test',
  hostPlatform: 'darwin/arm64',
  startedAt: '2026-09-05T00:00:04Z',
  completedAt: '2026-09-05T00:00:05Z',
  disposition: 'complete',
}
const ledger: ReviewLedger = {
  schemaVersion: 1,
  reviewId,
  entries: [
    {
      entryId: `entry_${'0'.repeat(25)}1`,
      ...writerChoice,
      choiceKey: 'storage.authority',
      effect: 'assert',
      assertion,
      headline: 'The repository store is the only writer.',
      confidence: 'high',
      evidence: [
        {
          object: {
            algorithm: 'sha256',
            sha256: '9'.repeat(64),
            bytes: 1,
            mediaType: 'text/plain',
            role: 'review-evidence',
          },
          locator: 'line 1',
        },
      ],
    },
  ],
}
const decision = deriveDecisionObservations(manifest, ledger, repositoryObservation)[0]!

const records: RepositoryRecords['records'] = [
  { path: 'sessions/codex/session-one/identity.json' as never, value: identity },
  {
    path: `sessions/codex/session-one/turns/${turn.turnId}/manifest.json` as never,
    value: turn as unknown as JsonValue,
  },
  {
    path: `sessions/codex/session-one/turns/${turn.turnId}/events.jsonl` as never,
    value: { sequence: 1 },
  },
  {
    path: `sessions/codex/session-one/turns/${turn.turnId}/events.jsonl` as never,
    value: { sequence: 2 },
  },
  {
    path: `repository-observations/${repositoryObservation.observationId}.json` as never,
    value: repositoryObservation as unknown as JsonValue,
  },
  {
    path: `reviews/workspace/${reviewId}/manifest.json` as never,
    value: manifest as unknown as JsonValue,
  },
  {
    path: `reviews/workspace/${reviewId}/ledger.json` as never,
    value: ledger as unknown as JsonValue,
  },
  { path: `reviews/workspace/${reviewId}/submissions.jsonl` as never, value: 'review response' },
  {
    path: `decisions/observations/${decision.observationId}.json` as never,
    value: decision as unknown as JsonValue,
  },
]

describe('UI projection', () => {
  test('keeps verified choices readable but unclassified without canonical policy', () => {
    const snapshot = buildUiProjection({ config: {}, records })
    if (snapshot.state !== 'ready') throw Error('fixture is ready')
    expect(snapshot.decisions?.stateFingerprint).toBeNull()
    const choice = snapshot.decisions?.groups.find(group => group.verdict === 'sound')?.choices[0]
    expect(choice).toMatchObject({
      scope: 'unclassified',
      observation: {
        headline: 'The repository store is the only writer.',
        scenario: writerChoice.scenario,
      },
    })
    expect(choice).not.toHaveProperty('humanStatus')
    expect(choice).not.toHaveProperty('lifecycle')
  })
  test('orders verdict then confidence with canonical priority and stable ties', () => {
    const raw = presentationDecisions()
    const entries = raw.lineages.flatMap(lineage => lineage.observations)
    const canonical = entries[0]!
    const proposal = {
      ...canonical,
      scope: 'proposal' as const,
      observation: { ...canonical.observation, choiceKey: 'aaa-proposal' },
    }
    const projected = presentDecisions({
      ...raw,
      lineages: [{ choiceKey: 'fixture', observations: [...entries.slice().reverse(), proposal] }],
    })
    expect(projected.groups.map(group => group.verdict)).toEqual(['needs-user', 'unsound', 'sound'])
    expect(projected.groups[0]!.choices.map(item => item.observation.headline)).toEqual([
      'Keep payment receipts for one year',
      'Keep payment receipts for one year',
      'Use email for failed-payment notifications',
    ])
    expect(projected.groups[0]!.choices.slice(0, 2).map(item => item.scope)).toEqual([
      'canonical',
      'proposal',
    ])
    expect(projected.groups[2]!.choices.map(item => item.observation.effect)).toEqual([
      'remove',
      'assert',
    ])
    expect(projected.groups[1]!.choices[0]!.observation).toMatchObject({
      correctedDecision:
        'One logical payment must keep the same idempotency key across all network retries.',
    })
  })
  test('presents standalone needs-user guidance without raw assertions or bundle objects', () => {
    const view = presentDecisions(presentationDecisions())
    const choice = view.groups[0]!.choices[0]!.observation
    if (choice.verdict !== 'needs-user') throw Error('fixture needs a user decision')
    expect(choice.headline).toBe('Keep payment receipts for one year')
    expect(choice.provisionalCall).toBe(
      'Keep receipts for 90 days while the owner chooses a retention policy.',
    )
    expect(choice.reversal).toContain('before the first scheduled deletion')
    expect(choice.scenario).toContain('Keeping it indefinitely')
    expect(choice).not.toHaveProperty('assertion')
    expect(choice).not.toHaveProperty('source')
    expect(choice.evidence[0]).toEqual({
      role: writerChoice.evidence[0]!.object.role,
      digest: writerChoice.evidence[0]!.object.sha256,
    })
  })
  test('is deterministic and keeps branches as turn context', () => {
    const first = buildUiProjection({ config: { canonicalBranch: 'main' }, records })
    const second = buildUiProjection({
      config: { canonicalBranch: 'main' },
      records: [...records].reverse(),
    })

    if (first.state !== 'ready' || second.state !== 'ready') throw new Error('fixture is ready')

    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(first.sessions[0]).toMatchObject({
      sessionKey: 'session-one',
      active: true,
      turns: [{ branch: 'feature/ui', evidenceWatermark: 2, eventCount: 2 }],
    })
    expect(
      first.decisions?.groups.find(group => group.verdict === 'sound')?.choices[0],
    ).toMatchObject({
      scope: 'canonical',
      lifecycle: 'canonical-current',
    })
    expect(first.unresolvedDisputes).toEqual([])
  })

  test('makes missing canonical policy explicit', () => {
    const snapshot = buildUiProjection({ config: {}, records: [] })
    if (snapshot.state !== 'ready') throw new Error('fixture is ready')
    expect(snapshot.decisions).toBeNull()
    expect(snapshot.diagnostics).toEqual([
      { priority: 'high', message: expect.stringContaining('Canonical branch') },
    ])
  })

  test('rejects a review group that is not an exact committed unit', () => {
    expect(() =>
      buildUiProjection({
        config: { canonicalBranch: 'main' },
        records: [
          ...records,
          {
            path: `reviews/workspace/${reviewId}/unexpected.json` as never,
            value: { forged: true },
          },
        ],
      }),
    ).toThrow('stored review does not have an exact committed record group')
  })

  test('does not describe context-only evidence as reviewed coverage', () => {
    const triggerId = `trigger_${'0'.repeat(25)}1` as const
    const contextManifest: ReviewManifest = {
      ...manifest,
      evidenceSelections: [
        {
          kind: 'range',
          triggerId,
          sessionKey: identity.sessionKey,
          turnId: turn.turnId,
          evidenceWatermark: turn.eventRange.last,
          selectedForReview: true,
          coverageEffect: 'context-only',
          classification: 'weak-context',
          reason: 'context-only',
          limitations: [],
        },
      ],
    }
    const snapshot = buildUiProjection({
      config: { canonicalBranch: 'main' },
      records: [
        ...records.map(record =>
          record.path === `reviews/workspace/${reviewId}/manifest.json`
            ? { ...record, value: contextManifest as unknown as JsonValue }
            : record,
        ),
        {
          path: `review-triggers/${triggerId}.json` as never,
          value: {
            schemaVersion: 1,
            triggerId,
            sessionKey: identity.sessionKey,
            turnId: turn.turnId,
            evidenceWatermark: turn.eventRange.last,
            provider: 'codex',
            createdAt: '2026-09-05T00:00:03Z',
            materialization: 'complete',
            limitations: [],
          },
        },
      ],
    })
    if (snapshot.state !== 'ready') throw new Error('fixture is ready')
    expect(snapshot.triggers[0]?.coverage).toBe('pending')
  })

  test('orders reviews chronologically rather than by subject path or timestamp spelling', () => {
    const laterReviewId = `review_${'0'.repeat(26)}` as const
    const laterManifest: ReviewManifest = {
      ...manifest,
      reviewId: laterReviewId,
      completedAt: '2026-09-05T00:00:05.1Z',
    }
    const snapshot = buildUiProjection({
      config: { canonicalBranch: 'main' },
      records: [
        ...records,
        {
          path: `reviews/workspace/${laterReviewId}/manifest.json` as never,
          value: laterManifest as unknown as JsonValue,
        },
        {
          path: `reviews/workspace/${laterReviewId}/ledger.json` as never,
          value: {
            schemaVersion: 1,
            reviewId: laterReviewId,
            entries: [],
            summary: JSON.parse(canonicalJson(emptyAuditSummary(writerChoice.evidence))),
          },
        },
        {
          path: `reviews/workspace/${laterReviewId}/submissions.jsonl` as never,
          value: 'later response',
        },
      ],
    })
    if (snapshot.state !== 'ready') throw new Error('fixture is ready')
    expect(snapshot.reviews.map(review => review.reviewId)).toEqual([reviewId, laterReviewId])
  })
})
