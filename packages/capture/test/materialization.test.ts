import { describe, expect, test } from 'bun:test'

import { canonicalJson, type ObjectRef, type RepositoryObservation } from '@factory/contract'
import type { DurableCaptureEvent, MaterializationClaim } from '@factory/runtime-journal'

import { executeTurn, planTurn, reduceRepository } from '../src/index'

const ref = (sha256: string, bytes: number, role: string): ObjectRef => ({
  algorithm: 'sha256',
  sha256,
  bytes,
  mediaType: 'application/json',
  role,
})

describe('Stop materialization', () => {
  test('plans deterministically and commits the trigger last', async () => {
    const claim: MaterializationClaim = {
      claimId: 'claim',
      stop: { provider: 'codex', sessionId: 'native', generation: 0, stopId: 'stop-native' },
      claimedAt: '2026-09-04T00:00:01Z',
      throughSequence: 1,
      eventKeys: ['first', 'stop'],
    }
    const events: DurableCaptureEvent[] = [
      {
        provider: 'codex',
        sessionId: 'native',
        generation: 0,
        eventId: 'first',
        eventKind: 'session-start',
        occurredAt: '2026-09-04T00:00:00Z',
        sequence: 0,
        eventKey: 'first',
        rawSha256: '1'.repeat(64),
        byteLength: 2,
      },
      {
        provider: 'codex',
        sessionId: 'native',
        generation: 0,
        eventId: 'stop',
        eventKind: 'stop',
        stopId: 'stop-native',
        occurredAt: '2026-09-04T00:00:01Z',
        sequence: 1,
        eventKey: 'stop',
        rawSha256: '2'.repeat(64),
        byteLength: 2,
      },
    ]
    const observation: RepositoryObservation = {
      schemaVersion: 1,
      observationId: 'observation_01K4A1M6000000000000000000',
      repositoryId: 'repo_fixture',
      observedAt: '2026-09-04T00:00:01Z',
      completedAt: '2026-09-04T00:00:01Z',
      git: { head: 'a'.repeat(40), branch: 'feature', detached: false },
      changedPaths: [],
      worktreeFingerprint: '3'.repeat(64),
      limitations: [],
      startState: '4'.repeat(64),
      endState: '4'.repeat(64),
    }
    const input = {
      repositoryId: 'repo_fixture' as const,
      claim,
      events: events.map((event, index) => ({
        event,
        raw: ref(String(index + 1).repeat(64), 2, 'provider-hook'),
      })),
      observation,
      materializedAt: '2026-09-04T00:00:02Z',
      adapterVersion: 'capture-v1',
      sessionFirstObservedAt: '2026-09-04T00:00:00Z',
      transcript: [],
    }

    const first = planTurn(input)
    const second = planTurn(input)
    expect(first).toEqual(second)
    if ('reason' in first) throw new Error(first.reason)

    const calls: string[][] = []
    const turn = await executeTurn(first, {
      publishImmutableGroup(records, commitPath) {
        calls.push(records.map(record => record.path))
        expect(commitPath).toStartWith('review-triggers/')
        const bytes = records.find(record => record.path === commitPath)!.bytes
        return Promise.resolve({
          path: commitPath,
          sha256: Bun.CryptoHasher.hash('sha256', bytes, 'hex'),
          bytes: bytes.byteLength,
        })
      },
    })

    expect(turn.path).toStartWith('sessions/codex/')
    expect(calls).toHaveLength(1)
    const projection = reduceRepository({
      records: first.records.map(record => ({
        path: record.path,
        value: record.path.endsWith('.json')
          ? JSON.parse(new TextDecoder().decode(record.bytes).split('\n')[0]!)
          : null,
      })),
    })
    expect(projection.sessions).toEqual([
      expect.objectContaining({ provider: 'codex', nativeSessionId: 'native', turns: 1 }),
    ])
    expect(canonicalJson(projection)).toContain('stop-native')

    const laterClaim = {
      ...claim,
      claimId: 'claim-later',
      stop: { ...claim.stop, stopId: 'stop-later' },
      claimedAt: '2026-09-04T00:01:01Z',
      throughSequence: 3,
      eventKeys: ['next', 'stop-later'],
    }
    const later = planTurn({
      ...input,
      claim: laterClaim,
      events: input.events.map((item, index) => ({
        ...item,
        event: {
          ...item.event,
          sequence: index + 2,
          eventKey: laterClaim.eventKeys[index]!,
          eventId: laterClaim.eventKeys[index]!,
          stopId: item.event.eventKind === 'stop' ? 'stop-later' : undefined,
        },
      })),
      sessionFirstObservedAt: '2026-09-04T00:00:00Z',
    })
    if ('reason' in later) throw new Error(later.reason)
    expect(new TextDecoder().decode(later.records[0]!.bytes)).toEqual(
      new TextDecoder().decode(first.records[0]!.bytes),
    )

    expect(
      planTurn({
        ...input,
        events: input.events.map((item, index) =>
          index === 0 ? { ...item, parsed: 'x'.repeat(4 * 1024 * 1024) } : item,
        ),
      }),
    ).toMatchObject({ reason: 'record-limit' })
  })
})
