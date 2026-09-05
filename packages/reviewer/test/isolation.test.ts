import { describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planReviewerIsolation, resolveReviewerIsolation, selectReviewer } from '../src/index'

describe('reviewer isolation plan', () => {
  const defaults = {
    codex: { model: 'gpt-test', effort: 'high' },
    claude: { model: 'claude-test', effort: 'high' },
  } as const

  test('selects exactly one cross-harness reviewer from the newest covered Stop', () => {
    expect(selectReviewer('auto', 'codex', { codex: true, claude: true }, defaults)).toEqual({
      kind: 'selected',
      choice: {
        settings: { provider: 'claude', model: 'claude-test', effort: 'high' },
        authoringProvider: 'codex',
      },
    })
    expect(selectReviewer('auto', 'codex', { codex: true, claude: false }, defaults)).toEqual({
      kind: 'selected',
      choice: {
        settings: { provider: 'codex', model: 'gpt-test', effort: 'high' },
        authoringProvider: 'codex',
      },
    })
  })

  test('never falls back from an explicit unavailable provider', () => {
    expect(
      selectReviewer(
        { provider: 'claude', model: 'opus' },
        'codex',
        { codex: true, claude: false },
        defaults,
      ),
    ).toEqual({
      kind: 'unavailable',
      choice: {
        settings: { provider: 'claude', model: 'opus', effort: 'high' },
        authoringProvider: 'codex',
      },
      reason: 'authentication-unavailable',
    })
  })

  test('pins an intended reviewer when authentication is unavailable', () => {
    expect(selectReviewer('auto', 'claude', { codex: false, claude: false }, defaults)).toEqual({
      kind: 'unavailable',
      choice: {
        settings: { provider: 'codex', model: 'gpt-test', effort: 'high' },
        authoringProvider: 'claude',
      },
      reason: 'authentication-unavailable',
    })
    expect(selectReviewer('auto', undefined, { codex: false, claude: true }, defaults)).toEqual({
      kind: 'selected',
      choice: { settings: { provider: 'claude', model: 'claude-test', effort: 'high' } },
    })
  })

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
        providerHome: {
          containerPath: '/auth/codex',
          mode: 'tmpfs',
          options: 'rw,noexec,nosuid,nodev,size=16m',
        },
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

  test('refuses a mount source Docker could parse as extra options', () => {
    expect(
      planReviewerIsolation({
        provider: 'codex',
        bundleHostPath: '/tmp/factory/bundle,readonly',
        outputHostPath: '/tmp/factory/output',
        auth: [],
      }),
    ).toMatchObject({ ok: false, reason: 'host-path-unsupported' })
  })

  test('refuses writable output that aliases the bundle through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-isolation-plan-'))
    const bundle = join(root, 'bundle')
    await mkdir(bundle)
    await symlink(bundle, join(root, 'output'))

    const result = await resolveReviewerIsolation({
      provider: 'codex',
      bundleHostPath: bundle,
      outputHostPath: join(root, 'output'),
      auth: [],
    })

    expect(result).toMatchObject({ ok: false, reason: 'host-path-overlap' })
  })

  test('binds authentication to one ordinary canonical file identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-isolation-auth-'))
    const bundle = join(root, 'bundle')
    const output = join(root, 'output')
    const auth = join(root, 'auth.json')
    await Promise.all([mkdir(bundle), mkdir(output), writeFile(auth, '{}', { mode: 0o600 })])
    const metadata = await lstat(auth)
    const input = {
      provider: 'codex' as const,
      bundleHostPath: bundle,
      outputHostPath: output,
      auth: [
        {
          hostPath: auth,
          containerPath: '/auth/codex/auth.json' as const,
          expectedIdentity: {
            dev: metadata.dev,
            ino: metadata.ino,
            size: metadata.size,
            uid: metadata.uid,
            mode: metadata.mode,
          },
        },
      ],
    }
    await expect(resolveReviewerIsolation(input)).resolves.toMatchObject({ ok: true })
    await expect(
      resolveReviewerIsolation({
        ...input,
        auth: [
          { ...input.auth[0]!, expectedIdentity: { ...input.auth[0]!.expectedIdentity, size: 9 } },
        ],
      }),
    ).rejects.toThrow('changed during canonicalization')

    const alias = join(root, 'auth-alias.json')
    await symlink(auth, alias)
    await expect(
      resolveReviewerIsolation({
        ...input,
        auth: [{ ...input.auth[0]!, hostPath: alias }],
      }),
    ).rejects.toThrow('changed during canonicalization')
  })
})
