import { describe, expect, test } from 'bun:test'

import { planReviewerIsolation } from '../src/index'

describe('reviewer isolation plan', () => {
  test('allows only the bundle, output, and selected provider auth', () => {
    expect(
      planReviewerIsolation({
        provider: 'codex',
        bundleHostPath: '/tmp/factory/bundle',
        outputHostPath: '/tmp/factory/output',
        auth: [
          {
            hostPath: '/tmp/factory/codex/auth.json',
            containerPath: '/auth/codex/auth.json',
          },
        ],
      }),
    ).toEqual({
      ok: true,
      plan: {
        provider: 'codex',
        bundle: {
          hostPath: '/tmp/factory/bundle',
          containerPath: '/bundle',
          mode: 'ro',
        },
        output: {
          hostPath: '/tmp/factory/output',
          containerPath: '/out',
          mode: 'rw',
        },
        auth: [
          {
            hostPath: '/tmp/factory/codex/auth.json',
            containerPath: '/auth/codex/auth.json',
            mode: 'ro',
          },
        ],
      },
    })
  })

  test('refuses auth mounted outside the selected provider scope', () => {
    expect(
      planReviewerIsolation({
        provider: 'codex',
        bundleHostPath: '/tmp/factory/bundle',
        outputHostPath: '/tmp/factory/output',
        auth: [
          {
            hostPath: '/tmp/factory/claude/credentials.json',
            containerPath: '/auth/claude/credentials.json',
          },
        ],
      }),
    ).toEqual({
      ok: false,
      reason: 'auth-target-outside-provider-scope',
      detail: 'auth target must be below /auth/codex/',
    })
  })

  test('refuses an auth target that escapes through parent segments', () => {
    expect(
      planReviewerIsolation({
        provider: 'codex',
        bundleHostPath: '/tmp/factory/bundle',
        outputHostPath: '/tmp/factory/output',
        auth: [
          {
            hostPath: '/tmp/factory/codex/auth.json',
            containerPath: '/auth/codex/../claude/auth.json',
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      reason: 'auth-target-outside-provider-scope',
    })
  })
})
