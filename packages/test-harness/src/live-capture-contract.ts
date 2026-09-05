import assert from 'node:assert/strict'

import type { SessionIdentity, TurnManifest } from '@factory/contract'

/** Only terminal assistant/result records can prove completion; echoed prompts cannot. */
export function liveCaptureCompleted(
  provider: 'codex' | 'claude',
  output: string,
  expected: string,
) {
  const rows = output
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  return provider === 'codex'
    ? rows.some(
        row =>
          row.type === 'item.completed' &&
          row.item?.type === 'agent_message' &&
          row.item.text?.trim() === expected,
      )
    : rows.some(
        row =>
          row.type === 'result' && row.subtype === 'success' && row.result?.trim() === expected,
      )
}

export type CaptureCallback = {
  phase: 'capture' | 'reader-refusal'
  event: string
  sessionId: string
  stopId: string | null
  rawSha256: string
  transcriptBytes: number
  code: number
  stdout: string
}

export type LiveCaptureObservation = {
  provider: 'codex' | 'claude'
  firstCompleted: boolean
  secondCompleted: boolean
  faultCompleted: boolean
  faultPreservedRepository: boolean
  identities: SessionIdentity[]
  manifests: TurnManifest[]
  callbacks: CaptureCallback[]
}

/** Turn observed native callbacks into narrow, independently checkable certification. */
export function certifyLiveCapture(observed: LiveCaptureObservation) {
  assert.equal(observed.firstCompleted, true, 'initial provider turn did not complete')
  assert.equal(observed.secondCompleted, true, 'resumed provider turn did not complete')
  assert.equal(observed.identities.length, 1, 'resuming must preserve the native Session')
  const identity = observed.identities[0]!
  assert.equal(identity.provider, observed.provider)
  assert.equal(observed.manifests.length, 2, 'both real Stops must materialize')
  const callbacks = observed.callbacks.filter(row => row.phase === 'capture')
  const stops = callbacks.filter(row => row.event === 'Stop')
  assert.equal(callbacks.filter(row => row.event === 'SessionStart').length, 2)
  assert.equal(stops.length, 2)
  assert.equal(new Set(stops.map(row => row.stopId)).size, 2, 'Stops need distinct native IDs')
  for (const callback of observed.callbacks) {
    assert.equal(callback.sessionId, identity.nativeSessionId)
    assert.equal(callback.code, 0, 'capture must be fail-open')
    assert.equal(callback.stdout, '{}\n', 'provider must receive its valid empty response')
  }
  for (const stop of stops) {
    assert.ok(stop.stopId)
    assert.ok(stop.transcriptBytes > 0, 'real Stop must expose a readable transcript')
    const turn = observed.manifests.find(value => value.nativeStopId === stop.stopId)
    assert.ok(turn, 'each native Stop must match its immutable Turn')
    assert.equal(turn.sessionKey, identity.sessionKey)
    assert.ok(
      turn.rawObjects.some(value => value.sha256 === stop.rawSha256),
      'native Stop bytes must survive unchanged',
    )
    assert.ok(turn.transcriptObservations.some(value => value.bytes > 0))
  }
  assert.equal(observed.faultCompleted, true, 'provider must finish despite reader refusal')
  assert.equal(observed.faultPreservedRepository, true, 'too-new repository must remain untouched')
  assert.ok(observed.callbacks.some(row => row.phase === 'reader-refusal' && row.event === 'Stop'))
  return {
    provider: observed.provider,
    nativeSessionPreserved: true,
    distinctNativeStops: true,
    rawStopBytesPreserved: true,
    readableStopTranscripts: true,
    readerRefusalFailOpen: true,
    events: callbacks.map(row => row.event),
    transcriptBytesAtStops: stops.map(row => row.transcriptBytes),
    turnLimitations: observed.manifests.map(turn => turn.limitations),
    callbacks: observed.callbacks.map(({ sessionId, stopId, ...row }) => ({
      ...row,
      nativeSessionMatches: sessionId === identity.nativeSessionId,
      hasNativeStopId: stopId !== null,
    })),
  }
}
