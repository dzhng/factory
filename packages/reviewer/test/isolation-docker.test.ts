import { describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveReviewerIsolation } from '../src/index'

if (process.env.FACTORY_DOCKER_TEST !== '1') {
  throw new Error('Isolation filesystem tests require Docker; run the package test script')
}

describe('reviewer isolation filesystem', () => {
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
