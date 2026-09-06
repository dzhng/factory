import { expect, test } from 'bun:test'

import {
  certifyLiveCapture,
  liveCaptureCompleted,
  type LiveCaptureObservation,
} from '../src/live-capture-contract'

function observation(provider: 'codex' | 'claude'): LiveCaptureObservation {
  const at = '2026-09-04T00:00:00Z'
  const evidence = {
    algorithm: 'sha256' as const,
    sha256: 'a'.repeat(64),
    bytes: 12,
    mediaType: 'application/json',
    role: 'provider-hook',
  }
  return {
    provider,
    firstCompleted: true,
    secondCompleted: true,
    faultCompleted: true,
    faultPreservedRepository: true,
    identities: [
      {
        schemaVersion: 1,
        provider,
        nativeSessionId: 'native-session',
        sessionKey: 'session',
        captureGeneration: 0,
        repositoryId: 'repo_fixture',
        firstObservedAt: at,
      },
    ],
    manifests: [1, 2].map(index => ({
      schemaVersion: 1,
      turnId: `turn_01K4A1M600000000000000000${index}`,
      sessionKey: 'session',
      nativeStopId: `stop-${index}`,
      capturedAt: at,
      materializedAt: at,
      eventRange: { first: index, last: index },
      transcriptObservations: [evidence],
      evidenceObjects: [evidence],
      limitations: [],
      captureAdapterVersion: 'fixture',
      formatVersion: 1,
      inventory: [evidence],
    })),
    callbacks: [
      ...[1, 2].flatMap(index =>
        ['SessionStart', 'Stop'].map(event => ({
          phase: 'capture' as const,
          event,
          sessionId: 'native-session',
          stopId: event === 'Stop' ? `stop-${index}` : null,
          rawSha256: 'b'.repeat(64),
          transcriptBytes: 12,
          code: 0,
          stdout: '{}\n',
        })),
      ),
      {
        phase: 'reader-refusal',
        event: 'Stop',
        sessionId: 'native-session',
        stopId: 'fault',
        rawSha256: 'b'.repeat(64),
        transcriptBytes: 12,
        code: 0,
        stdout: '{}\n',
      },
    ],
  }
}

test('live capture certification requires matching native Stops, prepared evidence, and valid callback responses', () => {
  const actual = observation('codex')
  expect(certifyLiveCapture(actual).readerRefusalFailOpen).toBe(true)
  const missing = structuredClone(actual)
  missing.callbacks = missing.callbacks.filter(row => row.event !== 'Stop')
  expect(() => certifyLiveCapture(missing)).toThrow()
  const changed = structuredClone(actual)
  changed.manifests[0]!.evidenceObjects = []
  expect(() => certifyLiveCapture(changed)).toThrow(
    'native Stop must retain readable prepared evidence',
  )
  const blocked = structuredClone(actual)
  blocked.callbacks.find(row => row.phase === 'reader-refusal')!.code = 1
  expect(() => certifyLiveCapture(blocked)).toThrow('capture must be fail-open')
})

test('live Claude certification preserves native prompt identity across resume', () => {
  const actual = observation('claude')
  expect(certifyLiveCapture(actual).nativeSessionPreserved).toBe(true)
  actual.callbacks.find(row => row.event === 'Stop')!.sessionId = 'different-native-session'
  expect(() => certifyLiveCapture(actual)).toThrow()
})

test('echoed prompts cannot certify provider completion', () => {
  const expected = 'FACTORY_CAPTURE_OK'
  const echo = JSON.stringify({ type: 'user', text: expected })
  expect(liveCaptureCompleted('codex', echo, expected)).toBe(false)
  expect(liveCaptureCompleted('claude', echo, expected)).toBe(false)
  expect(
    liveCaptureCompleted(
      'codex',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: expected } }),
      expected,
    ),
  ).toBe(true)
  expect(
    liveCaptureCompleted(
      'claude',
      JSON.stringify({ type: 'result', subtype: 'success', result: expected }),
      expected,
    ),
  ).toBe(true)
})
