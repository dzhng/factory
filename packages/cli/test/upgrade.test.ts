import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withAdvisoryFileLock } from '@factory/repository'

import { runFactoryCli } from '../src'
import {
  inspectInstallation,
  installHooks,
  recoverInstallationTransaction,
  uninstallHooks,
  upgradeInstallation,
} from '../src/installation'
import { verifyReleaseArtifact } from '../src/release-manifest'
import { releaseFixture } from './release-fixture'

if (
  process.env.FACTORY_DOCKER_TEST !== '1' ||
  process.platform !== 'linux' ||
  process.arch !== 'x64'
) {
  throw new Error('upgrade tests require the glibc Linux x64 Docker authority')
}

const encoder = new TextEncoder()

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'factory-upgrade-'))
  const home = join(root, 'home')
  const executable = join(root, 'bin', 'factory')
  await Promise.all([
    mkdir(join(home, '.codex'), { recursive: true }),
    mkdir(join(home, '.claude'), { recursive: true }),
    mkdir(join(root, 'bin')),
  ])
  const oldBytes = encoder.encode('#!/bin/sh\nprintf "0.1.0-old\\n"\n')
  await writeFile(executable, oldBytes)
  await chmod(executable, 0o755)
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
  }
  await installHooks(executable, environment)
  const version = '0.2.0-test.1'
  const newBytes = encoder.encode(`#!/bin/sh\nprintf "${version}\\n"\n`)
  const artifact = await releaseFixture({
    target: 'bun-linux-x64-baseline',
    version,
    executable: newBytes,
  })
  const release = await verifyReleaseArtifact({
    ...artifact,
    expectedTarget: 'bun-linux-x64-baseline',
  })
  await Promise.all([
    writeFile(join(root, 'factory.tar.gz'), artifact.archive),
    writeFile(join(root, 'manifest.json'), artifact.adjacentManifest),
  ])
  return { root, executable, environment, oldBytes, newBytes, artifact, release }
}

async function expectHealthy(
  value: Awaited<ReturnType<typeof fixture>>,
  transaction: 'absent' | 'pending',
): Promise<void> {
  const status = await inspectInstallation(value.environment)
  expect(status).toMatchObject({
    ownership: 'available',
    executable: { path: value.executable, state: 'ready' },
    transaction,
  })
  for (const provider of ['codex', 'claude'] as const) {
    expect(
      status.providers[provider].hooks?.events.every(event => event.state === 'installed'),
    ).toBe(true)
  }
}

async function crashAfterStage(value: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  process.env.FACTORY_TEST_UPGRADE_CRASH = 'after-stage'
  try {
    await expect(upgradeInstallation(value.release, value.environment)).rejects.toThrow(
      'injected crash',
    )
  } finally {
    delete process.env.FACTORY_TEST_UPGRADE_CRASH
  }
  return join(value.environment.XDG_CONFIG_HOME!, 'factory', 'installation-transaction.json')
}

describe('verified executable upgrade', () => {
  test('completes through the shared installation transaction', async () => {
    const value = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runFactoryCli(
      [
        'upgrade',
        '--archive',
        'factory.tar.gz',
        '--manifest',
        'manifest.json',
        '--manifest-sha256',
        value.artifact.expectedManifestSha256,
      ],
      {
        cwd: value.root,
        environment: value.environment,
        output: { stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      },
    )
    expect({ code, stdout: stdout.join(''), stderr: stderr.join('') }).toEqual({
      code: 0,
      stdout: `Factory upgraded to ${value.release.version}.\n`,
      stderr: '',
    })
    expect(await readFile(value.executable)).toEqual(Buffer.from(value.newBytes))
    await expectHealthy(value, 'absent')
  })

  test('recovers a verified old or new executable at every crash boundary', async () => {
    for (const boundary of ['after-journal', 'after-stage', 'after-executable'] as const) {
      const value = await fixture()
      process.env.FACTORY_TEST_UPGRADE_CRASH = boundary
      try {
        await expect(upgradeInstallation(value.release, value.environment)).rejects.toThrow(
          'injected crash',
        )
      } finally {
        delete process.env.FACTORY_TEST_UPGRADE_CRASH
      }
      expect(await readFile(value.executable)).toEqual(
        Buffer.from(boundary === 'after-executable' ? value.newBytes : value.oldBytes),
      )
      await expectHealthy(value, 'pending')

      await recoverInstallationTransaction(value.environment)
      expect(await readFile(value.executable)).toEqual(
        Buffer.from(boundary === 'after-journal' ? value.oldBytes : value.newBytes),
      )
      await expectHealthy(value, 'absent')

      if (boundary === 'after-journal') {
        await upgradeInstallation(value.release, value.environment)
        expect(await readFile(value.executable)).toEqual(Buffer.from(value.newBytes))
      }
    }
  })

  test('finalizes an interrupted reinstall of identical executable bytes', async () => {
    const value = await fixture()
    const artifact = await releaseFixture({
      target: 'bun-linux-x64-baseline',
      version: '0.1.0-old',
      executable: value.oldBytes,
    })
    const release = await verifyReleaseArtifact({
      ...artifact,
      expectedTarget: 'bun-linux-x64-baseline',
    })
    process.env.FACTORY_TEST_UPGRADE_CRASH = 'after-executable'
    try {
      await expect(upgradeInstallation(release, value.environment)).rejects.toThrow(
        'injected crash',
      )
    } finally {
      delete process.env.FACTORY_TEST_UPGRADE_CRASH
    }
    await recoverInstallationTransaction(value.environment)
    expect(await readFile(value.executable)).toEqual(Buffer.from(value.oldBytes))
    await expectHealthy(value, 'absent')
  })

  test('rolls back a staged executable that fails its release identity check', async () => {
    const value = await fixture()
    const badArtifact = await releaseFixture({
      target: 'bun-linux-x64-baseline',
      version: value.release.version,
      executable: encoder.encode('#!/bin/sh\nprintf "wrong-version\\n"\n'),
    })
    const badRelease = await verifyReleaseArtifact({
      ...badArtifact,
      expectedTarget: 'bun-linux-x64-baseline',
    })
    await expect(upgradeInstallation(badRelease, value.environment)).rejects.toThrow(
      'failed its version check',
    )
    expect(await readFile(value.executable)).toEqual(Buffer.from(value.oldBytes))
    await expectHealthy(value, 'pending')
    await recoverInstallationTransaction(value.environment)
    expect(await readFile(value.executable)).toEqual(Buffer.from(value.oldBytes))
    await expectHealthy(value, 'absent')
  })

  test('refuses recovery after the installed executable diverges', async () => {
    const value = await fixture()
    await crashAfterStage(value)
    const edited = encoder.encode('#!/bin/sh\nprintf "user-edit\\n"\n')
    await writeFile(value.executable, edited)
    await chmod(value.executable, 0o755)
    await expect(recoverInstallationTransaction(value.environment)).rejects.toThrow(
      'installed executable changed',
    )
    expect(await readFile(value.executable)).toEqual(Buffer.from(edited))
    expect((await inspectInstallation(value.environment)).transaction).toBe('invalid')
  })

  test('revalidates installed and staged bytes immediately before promotion', async () => {
    for (const mutation of ['installed', 'staged'] as const) {
      const value = await fixture()
      const version = value.release.version
      const mutatingBytes =
        mutation === 'installed'
          ? encoder.encode(
              `#!/bin/sh\ninstalled="\${0%%.factory-upgrade-*}"\nprintf '#!/bin/sh\\nprintf user-edit\\n' > "$installed"\nchmod 755 "$installed"\nprintf '${version}\\n'\n`,
            )
          : encoder.encode(
              `#!/bin/sh\nprintf '${version}\\n'\nprintf '#!/bin/sh\\nprintf changed\\n' > "$0"\nchmod 755 "$0"\n`,
            )
      const artifact = await releaseFixture({
        target: 'bun-linux-x64-baseline',
        version,
        executable: mutatingBytes,
      })
      const release = await verifyReleaseArtifact({
        ...artifact,
        expectedTarget: 'bun-linux-x64-baseline',
      })
      await expect(upgradeInstallation(release, value.environment)).rejects.toThrow(
        mutation === 'installed' ? 'installed executable changed' : 'changed after verification',
      )
      expect(await readFile(value.executable)).not.toEqual(Buffer.from(mutatingBytes))
      expect((await inspectInstallation(value.environment)).transaction).toBe('invalid')
    }
  })

  test('rejects hostile executable transaction states without mutation', async () => {
    for (const scenario of ['phase', 'target', 'missing', 'corrupt', 'mode'] as const) {
      const value = await fixture()
      const transactionPath = await crashAfterStage(value)
      const transaction = JSON.parse(await readFile(transactionPath, 'utf8'))
      if (scenario === 'phase') transaction.stage = 'unknown'
      if (scenario === 'target') transaction.release.target = 'bun-darwin-arm64'
      if (scenario === 'missing') await unlink(transaction.stagedPath)
      if (scenario === 'corrupt') await writeFile(transaction.stagedPath, 'corrupt')
      if (scenario === 'mode') await chmod(transaction.stagedPath, 0o600)
      if (scenario === 'phase' || scenario === 'target') {
        await writeFile(transactionPath, `${JSON.stringify(transaction)}\n`, { mode: 0o600 })
      }
      expect((await inspectInstallation(value.environment)).transaction).toBe('invalid')
      await expect(recoverInstallationTransaction(value.environment)).rejects.toThrow()
      expect(await readFile(value.executable)).toEqual(Buffer.from(value.oldBytes))
    }
  })

  test('serializes installation mutations on one external lock', async () => {
    const value = await fixture()
    const lock = join(value.environment.XDG_CONFIG_HOME!, 'factory', 'installation.lock')
    let completed = false
    let uninstall: Promise<void> | undefined
    await withAdvisoryFileLock(lock, 1_000, async () => {
      uninstall = uninstallHooks(value.environment).then(() => {
        completed = true
      })
      await Bun.sleep(50)
      expect(completed).toBe(false)
    })
    await uninstall
    expect(completed).toBe(true)
  })
})
