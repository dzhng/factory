import { afterEach, describe, expect, test } from 'bun:test'

import { serveLocalUi, UiActionConflictError, type LocalUiHandle } from '../src'

const handles: LocalUiHandle[] = []
const actionId = `action_${'0'.repeat(25)}1` as const
const observationId = `decision_${'0'.repeat(25)}1` as const

async function server(options: { conflict?: boolean; state?: 'ready' | 'corrupt' } = {}) {
  const decisions: unknown[] = []
  const coverage: unknown[] = []
  const handle = await serveLocalUi({
    host: '127.0.0.1',
    snapshot: async () =>
      options.state === 'corrupt'
        ? {
            schemaVersion: 1,
            state: 'corrupt',
            title: 'Factory data is unreadable',
            message: 'No actions are available.',
          }
        : {
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
            decisions: null,
            unresolvedDisputes: [],
            diagnostics: [],
          },
    actions: {
      async appendDecision(value) {
        if (options.conflict) throw new UiActionConflictError()
        decisions.push(value)
      },
      async acceptCoverage(value) {
        coverage.push(value)
      },
    },
  })
  handles.push(handle)
  return { handle, decisions, coverage }
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.stop()))
})

async function authority(handle: LocalUiHandle) {
  const response = await fetch(`${handle.origin}/api/session`)
  return (await response.json()) as { csrfToken: string }
}

describe('local UI server', () => {
  test('binds loopback, serves external assets with security headers, and stops', async () => {
    const { handle } = await server()
    expect(handle.hostname).toBe('127.0.0.1')
    const page = await fetch(handle.origin)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(await page.text()).not.toContain('<script>')
    expect((await fetch(`${handle.origin}/api/snapshot`)).status).toBe(200)

    await handle.stop()
    await handle.finished
    await expect(fetch(handle.origin)).rejects.toThrow()
  })

  test('rejects drive-by and structurally invalid mutations before the action port', async () => {
    const { handle, decisions } = await server()
    const session = await authority(handle)
    const valid = {
      actionId,
      kind: 'confirm',
      targetObservationId: observationId,
      expectedStateFingerprint: 'a'.repeat(64),
    }
    expect(
      (
        await fetch(`${handle.origin}/api/snapshot`, {
          headers: { host: `localhost:${handle.port}` },
        })
      ).status,
    ).toBe(421)
    expect(
      (
        await fetch(`${handle.origin}/api/actions/decision`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(valid),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${handle.origin}/api/actions/decision`, {
          method: 'POST',
          headers: {
            origin: handle.origin,
            'content-type': 'application/json',
            'x-factory-csrf': session.csrfToken,
          },
          body: JSON.stringify({ ...valid, actor: { kind: 'human' } }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await fetch(`${handle.origin}/api/actions/decision`, {
          method: 'POST',
          headers: {
            origin: handle.origin,
            'content-type': 'application/json',
            'x-factory-csrf': session.csrfToken,
          },
          body: JSON.stringify({ ...valid, note: 'é'.repeat(9 * 1024) }),
        })
      ).status,
    ).toBe(413)
    expect(decisions).toEqual([])
  })

  test('constructs human actions, reports stale authority, and disables unavailable repositories', async () => {
    const valid = {
      actionId,
      kind: 'confirm',
      targetObservationId: observationId,
      expectedStateFingerprint: 'a'.repeat(64),
    }
    const first = await server()
    const firstSession = await authority(first.handle)
    const accepted = await fetch(`${first.handle.origin}/api/actions/decision`, {
      method: 'POST',
      headers: {
        origin: first.handle.origin,
        'content-type': 'application/json',
        'x-factory-csrf': firstSession.csrfToken,
      },
      body: JSON.stringify(valid),
    })
    expect(accepted.status).toBe(201)
    expect(first.decisions).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        actor: { kind: 'human', label: 'factory open' },
      }),
    ])

    const stale = await server({ conflict: true })
    const staleSession = await authority(stale.handle)
    expect(
      (
        await fetch(`${stale.handle.origin}/api/actions/decision`, {
          method: 'POST',
          headers: {
            origin: stale.handle.origin,
            'content-type': 'application/json',
            'x-factory-csrf': staleSession.csrfToken,
          },
          body: JSON.stringify(valid),
        })
      ).status,
    ).toBe(409)

    const unavailable = await server({ state: 'corrupt' })
    const unavailableSession = await authority(unavailable.handle)
    expect(
      (
        await fetch(`${unavailable.handle.origin}/api/actions/coverage`, {
          method: 'POST',
          headers: {
            origin: unavailable.handle.origin,
            'content-type': 'application/json',
            'x-factory-csrf': unavailableSession.csrfToken,
          },
          body: JSON.stringify({ reviewId: `review_${'0'.repeat(25)}1` }),
        })
      ).status,
    ).toBe(409)
  })
})
