import { describe, expect, test } from 'bun:test'

import {
  canonicalJson,
  type EvidenceEnvelope,
  type ObjectRef,
  type RepositoryObservation,
  type ReviewTrigger,
  type SessionIdentity,
  type TurnManifest,
} from '@factory/contract'

import { verifyTurnEvidenceGraph, type TurnEvidenceGraph } from '../src/index'

const bytes = new TextEncoder().encode('{"event":true}\n')
const evidence: ObjectRef = {
  algorithm: 'sha256',
  sha256: Bun.CryptoHasher.hash('sha256', bytes, 'hex'),
  bytes: bytes.byteLength,
  mediaType: 'application/json',
  role: 'provider-hook',
}
const observation: RepositoryObservation = {
  schemaVersion: 1,
  observationId: 'observation_01K4A1M6000000000000000000',
  repositoryId: 'repo_fixture',
  observedAt: '2026-09-04T00:00:00Z',
  completedAt: '2026-09-04T00:00:00Z',
  git: { branch: 'feature', detached: false },
  changedPaths: [],
  worktreeFingerprint: 'a'.repeat(64),
  limitations: [],
  startState: 'b'.repeat(64),
  endState: 'b'.repeat(64),
}
const identity: SessionIdentity = {
  schemaVersion: 1,
  provider: 'codex',
  nativeSessionId: 'native',
  sessionKey: 'session-a',
  captureGeneration: 0,
  repositoryId: observation.repositoryId,
  firstObservedAt: observation.observedAt,
}
const events: EvidenceEnvelope[] = [
  { sequence: 1, observedAt: observation.observedAt, evidence },
  { sequence: 2, observedAt: observation.observedAt, evidence },
]
const turn: TurnManifest = {
  schemaVersion: 1,
  turnId: 'turn_01K4A1M6000000000000000000',
  sessionKey: identity.sessionKey,
  nativeStopId: 'stop',
  capturedAt: observation.observedAt,
  materializedAt: observation.observedAt,
  eventRange: { first: 1, last: 2 },
  transcriptObservations: [],
  evidenceObjects: [evidence, evidence],
  repositoryObservationId: observation.observationId,
  limitations: [],
  captureAdapterVersion: 'capture-v1',
  formatVersion: 1,
  inventory: [evidence],
}
const trigger: ReviewTrigger = {
  schemaVersion: 1,
  triggerId: 'trigger_01K4A1M6000000000000000000',
  sessionKey: identity.sessionKey,
  turnId: turn.turnId,
  repositoryObservationId: observation.observationId,
  evidenceWatermark: 2,
  provider: identity.provider,
  createdAt: observation.observedAt,
  materialization: 'complete',
  limitations: [],
}

const graph = (): TurnEvidenceGraph =>
  structuredClone({
    identity,
    trigger,
    turn,
    repositoryObservation: observation,
    events,
    transcript: [],
  })

describe('portable Turn evidence graph', () => {
  test('preserves ordered global journal gaps occupied by other Sessions', async () => {
    const value = graph()
    value.events = [value.events[0]!, { ...value.events[1]!, sequence: 4 }]
    value.turn.eventRange.last = 4
    value.trigger.evidenceWatermark = 4
    await expect(verifyTurnEvidenceGraph(value, async () => bytes)).resolves.toBeUndefined()
  })

  test('accepts one exact ordered transitive closure', async () => {
    await expect(
      verifyTurnEvidenceGraph(graph(), async reference => {
        expect(canonicalJson(reference)).toBe(canonicalJson(evidence))
        return bytes
      }),
    ).resolves.toBeUndefined()
  })

  test.each([
    ['omitted event', (value: TurnEvidenceGraph) => (value.events = value.events.slice(1))],
    ['reordered event', (value: TurnEvidenceGraph) => (value.events = [...value.events].reverse())],
    [
      'duplicate event',
      (value: TurnEvidenceGraph) => (value.events = [...value.events, value.events[1]!]),
    ],
    ['missing inventory', (value: TurnEvidenceGraph) => (value.turn.inventory = [])],
    [
      'extra inventory',
      (value: TurnEvidenceGraph) =>
        (value.turn.inventory = [...value.turn.inventory, { ...evidence, role: 'other' }]),
    ],
    ['wrong identity', (value: TurnEvidenceGraph) => (value.identity.sessionKey = 'session-b')],
    [
      'wrong repository',
      (value: TurnEvidenceGraph) => (value.identity.repositoryId = 'repo_other'),
    ],
    [
      'wrong observation',
      (value: TurnEvidenceGraph) =>
        (value.repositoryObservation!.observationId = 'observation_01K4A1M6000000000000000001'),
    ],
    [
      'changed limitations',
      (value: TurnEvidenceGraph) =>
        (value.trigger.limitations = [{ code: 'corrupt-input', detail: 'x' }]),
    ],
    [
      'false complete',
      (value: TurnEvidenceGraph) => {
        value.turn.limitations = [{ code: 'corrupt-input', detail: 'x' }]
        value.trigger.limitations = value.turn.limitations
      },
    ],
  ])('rejects %s', async (_name, mutate) => {
    const value = graph()
    mutate(value)
    await expect(verifyTurnEvidenceGraph(value, async () => bytes)).rejects.toThrow()
  })
})
