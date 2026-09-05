import { describe, expect, test } from 'bun:test'

import {
  claudeCaptureAdapter,
  codexCaptureAdapter,
  createCaptureAdapter,
  removeOwnedHooks,
} from '../src/index'

const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`)

describe('provider capture adapters', () => {
  test('classify native Stop bytes without discarding unknown fields', () => {
    const raw = encode({
      session_id: 'native-session',
      turn_id: 'native-turn',
      hook_event_name: 'Stop',
      cwd: '/repo',
      future_field: { must_survive: true },
    })
    const envelope = codexCaptureAdapter.classify(raw)

    expect(envelope).toMatchObject({
      provider: 'codex',
      nativeSessionId: 'native-session',
      nativeEvent: 'Stop',
      stopId: 'native-turn',
      worktreePath: '/repo',
    })
    expect(envelope.raw).toEqual(raw)
  })

  test('emit valid nonblocking responses for either provider', () => {
    for (const adapter of [codexCaptureAdapter, claudeCaptureAdapter]) {
      expect(
        JSON.parse(new TextDecoder().decode(adapter.providerResponse({ status: 'stored' }))),
      ).toEqual({})
      expect(
        JSON.parse(new TextDecoder().decode(adapter.providerResponse({ status: 'failed' }))),
      ).toEqual({})
    }
  })

  test('hook reconciliation preserves foreign data and converges duplicate Factory hooks', () => {
    const foreign = {
      futureTopLevelField: { preserve: true },
      hooks: {
        Stop: [
          {
            matcher: 'foreign',
            hooks: [{ type: 'command', command: '/foreign/stop', future: ['preserve'] }],
          },
        ],
      },
    }
    const first = codexCaptureAdapter.reconcileHooks(encode(foreign), '/opt/factory')
    const duplicated = JSON.parse(new TextDecoder().decode(first.bytes))
    duplicated.hooks.Stop.push(duplicated.hooks.Stop[1])
    const second = createCaptureAdapter('codex', first.ownedFingerprints).reconcileHooks(
      encode(duplicated),
      '/opt/factory',
    )
    const result = JSON.parse(new TextDecoder().decode(second.bytes))

    expect(result.futureTopLevelField).toEqual({ preserve: true })
    expect(
      result.hooks.Stop.filter((group: unknown) => JSON.stringify(group).includes('/opt/factory')),
    ).toHaveLength(1)
    expect(result.hooks.Stop[0]).toEqual(foreign.hooks.Stop[0])
    expect(
      createCaptureAdapter('codex', second.ownedFingerprints).reconcileHooks(
        second.bytes,
        '/opt/factory',
      ).changed,
    ).toBeFalse()
  })

  test('inspects exact, duplicate, stale, and edited-but-unowned hooks without claiming them', () => {
    const installed = codexCaptureAdapter.reconcileHooks(undefined, '/opt/factory')
    const adapter = createCaptureAdapter('codex', installed.ownedFingerprints)
    expect(
      adapter
        .inspectHooks(installed.bytes, '/opt/factory')
        .events.every(event => event.state === 'installed' && event.exactMatches === 1),
    ).toBeTrue()

    const unownedExact = codexCaptureAdapter
      .inspectHooks(installed.bytes, '/opt/factory')
      .events.find(event => event.event === 'Stop')!
    expect(unownedExact).toMatchObject({
      state: 'missing',
      exactMatches: 1,
      exactOwnedMatches: 0,
      factoryLikeUnownedMatches: 1,
    })

    const duplicated = JSON.parse(new TextDecoder().decode(installed.bytes))
    duplicated.hooks.Stop.push(structuredClone(duplicated.hooks.Stop[0]))
    const duplicateStop = adapter
      .inspectHooks(encode(duplicated), '/opt/factory')
      .events.find(event => event.event === 'Stop')!
    expect(duplicateStop).toMatchObject({ state: 'duplicate', exactMatches: 2 })

    const staleStop = adapter
      .inspectHooks(installed.bytes, '/opt/factory-next')
      .events.find(event => event.event === 'Stop')!
    expect(staleStop).toMatchObject({ state: 'stale', staleOwnedMatches: 1 })

    const edited = JSON.parse(new TextDecoder().decode(installed.bytes))
    edited.hooks.Stop[0].hooks[0].timeout = 99
    const editedStop = adapter
      .inspectHooks(encode(edited), '/opt/factory')
      .events.find(event => event.event === 'Stop')!
    expect(editedStop).toMatchObject({
      state: 'missing',
      exactMatches: 0,
      priorOwnedMatches: 0,
      factoryLikeUnownedMatches: 1,
    })
  })

  test('uninstall removes only exact recorded entries and preserves edited former hooks', () => {
    const installed = claudeCaptureAdapter.reconcileHooks(undefined, '/opt/factory')
    const edited = JSON.parse(new TextDecoder().decode(installed.bytes))
    edited.hooks.Stop[0].hooks[0].timeout = 99
    const removed = removeOwnedHooks('claude', encode(edited), installed.ownedFingerprints)
    const result = JSON.parse(new TextDecoder().decode(removed.bytes))

    expect(result.hooks.SessionStart).toEqual([])
    expect(result.hooks.Stop).toEqual(edited.hooks.Stop)
    expect(removed.foreignEdited).toContain('Stop')
  })

  test('uses one malformed hook-config boundary for inspection, install, and uninstall', () => {
    const malformed = encode({ hooks: { Stop: 'not-an-array' } })
    const adapter = createCaptureAdapter('codex')
    expect(() => adapter.inspectHooks(malformed, '/opt/factory')).toThrow(
      'provider hook configuration Stop must be an array',
    )
    expect(() => adapter.reconcileHooks(malformed, '/opt/factory')).toThrow(
      'provider hook configuration Stop must be an array',
    )
    expect(() =>
      removeOwnedHooks('codex', malformed, [{ event: 'Stop', fingerprint: '0'.repeat(64) }]),
    ).toThrow('provider hook configuration Stop must be an array')
  })
})
