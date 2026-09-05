import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inspectCaptureProviderEnvironment } from '../src/provider-environment'

const dockerDescribe = process.env.FACTORY_DOCKER_TEST === '1' ? describe : describe.skip

dockerDescribe('capture provider subprocess bounds', () => {
  test('times out and caps output independently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-provider-probe-'))
    const codex = join(root, 'codex')
    const claude = join(root, 'claude')
    await writeFile(codex, '#!/bin/sh\nwhile :; do printf xxxxxxxxxxxxxxxx; done\n', {
      mode: 0o755,
    })
    await writeFile(claude, '#!/bin/sh\nsleep 10\n', { mode: 0o755 })
    await Promise.all([chmod(codex, 0o755), chmod(claude, 0o755)])
    expect(
      await inspectCaptureProviderEnvironment(
        {},
        {
          executables: { codex, claude },
          maximumBytes: 128,
          maximumDurationMs: 100,
        },
      ),
    ).toEqual({
      codex: { availability: 'unavailable', reason: 'output-limit' },
      claude: { availability: 'unavailable', reason: 'timeout' },
    })
  })

  test('isolates a missing executable and preserves opaque version text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-provider-version-'))
    const claude = join(root, 'claude')
    await writeFile(claude, '#!/bin/sh\nprintf "2.0.0 (stable)\\n"\n', { mode: 0o755 })
    await chmod(claude, 0o755)
    expect(
      await inspectCaptureProviderEnvironment(
        {},
        {
          executables: { codex: join(root, 'missing'), claude },
          maximumDurationMs: 100,
        },
      ),
    ).toEqual({
      codex: { availability: 'unavailable', reason: 'missing' },
      claude: { availability: 'available', version: '2.0.0 (stable)' },
    })
  })
})
