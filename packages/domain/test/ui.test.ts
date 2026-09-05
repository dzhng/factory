import { describe, expect, test } from 'bun:test'

import {
  canonicalJson,
  decisionAssertionFingerprint,
  type DecisionObservation,
  type JsonValue,
  type RepositoryRecords,
} from '@factory/contract'

import { buildUiProjection } from '../src/ui'

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
  rawObjects: [],
  branch: 'feature/ui',
  limitations: [],
  captureAdapterVersion: 'test',
  formatVersion: 1,
  inventory: [],
} as const

const assertion = { storage: 'append-only' } as const
const decision: DecisionObservation = {
  schemaVersion: 1,
  observationId: `decision_${'0'.repeat(25)}1`,
  reviewId: `review_${'0'.repeat(25)}1`,
  reviewEntryId: `entry_${'0'.repeat(25)}1`,
  decisionKey: 'storage.authority',
  effect: 'assert',
  assertion,
  assertionFingerprint: decisionAssertionFingerprint({ effect: 'assert', assertion }),
  summary: 'The repository store is the only writer.',
  source: { kind: 'workspace', branch: 'main', exactSnapshot: true },
  confidence: 'high',
  observedAt: '2026-09-05T00:00:03Z',
}

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
    path: `decisions/observations/${decision.observationId}.json` as never,
    value: decision as unknown as JsonValue,
  },
]

describe('UI projection', () => {
  test('is deterministic and keeps branches as turn context', () => {
    const first = buildUiProjection({ config: { canonicalBranch: 'main' }, records })
    const second = buildUiProjection({
      config: { canonicalBranch: 'main' },
      records: [...records].reverse(),
    })

    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(first.sessions[0]).toMatchObject({
      sessionKey: 'session-one',
      active: true,
      turns: [{ branch: 'feature/ui', evidenceWatermark: 2, eventCount: 2 }],
    })
    expect(first.decisions?.lineages[0]?.observations[0]).toMatchObject({
      scope: 'canonical',
      lifecycle: 'canonical-current',
    })
  })

  test('makes missing canonical policy explicit', () => {
    const snapshot = buildUiProjection({ config: {}, records: [] })
    expect(snapshot.decisions).toBeNull()
    expect(snapshot.diagnostics).toEqual([
      { priority: 'high', message: expect.stringContaining('Canonical branch') },
    ])
  })
})
