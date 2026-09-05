import { expect, test } from 'bun:test'

import claudeObservation from '../../../specs/done/factory-v1/assets/live-capture/claude-observation.json'
import observation from '../../../specs/done/factory-v1/assets/live-capture/codex-observation.json'
import {
  certifyLiveCapture,
  liveCaptureCompleted,
  type LiveCaptureObservation,
} from '../src/live-capture-contract'

test('live capture certification requires real matching Stop bytes and valid callback responses', () => {
  const actual = structuredClone(observation) as LiveCaptureObservation
  expect(certifyLiveCapture(actual).readerRefusalFailOpen).toBe(true)
  const missing = structuredClone(actual)
  missing.callbacks = missing.callbacks.filter(row => row.event !== 'Stop')
  expect(() => certifyLiveCapture(missing)).toThrow()
  const changed = structuredClone(actual)
  changed.callbacks.find(row => row.event === 'Stop')!.rawSha256 = '0'.repeat(64)
  expect(() => certifyLiveCapture(changed)).toThrow('native Stop bytes must survive unchanged')
  const blocked = structuredClone(actual)
  blocked.callbacks.find(row => row.phase === 'reader-refusal')!.code = 1
  expect(() => certifyLiveCapture(blocked)).toThrow('capture must be fail-open')
})

test('live Claude certification preserves native prompt identity across resume', () => {
  const actual = structuredClone(claudeObservation) as LiveCaptureObservation
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
