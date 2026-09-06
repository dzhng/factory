import { expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runFactoryCli } from '../src'
import { withInstallationLock } from '../src/installation'
import { npmInstallation, upgradeNpmInstallation } from '../src/npm-upgrade'

if (process.env.FACTORY_DOCKER_TEST !== '1') throw new Error('Run in the Docker test environment')

async function fixture() {
  const root = await mkdtemp('/tmp/factory-npm-upgrade-')
  const prefix = join(root, 'prefix with spaces')
  const packageRoot = join(prefix, 'lib/node_modules/@dzhng/factory')
  const executable = join(packageRoot, 'native/linux-x64-baseline/factory')
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  await mkdir(join(packageRoot, 'native/linux-x64-baseline'), { recursive: true })
  await mkdir(home)
  await mkdir(bin)
  await writeFile(executable, 'old executable')
  await chmod(executable, 0o755)
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@dzhng/factory', version: '0.1.0' }),
  )
  // npm is the external installer boundary; materialize the outcome it owns.
  await writeFile(
    join(bin, 'npm'),
    `#!/usr/bin/env bun
await Bun.write(process.env.HOME + '/argv.json', JSON.stringify(process.argv.slice(2)))
await Bun.write(${JSON.stringify(join(packageRoot, 'package.json'))}, JSON.stringify({ name: '@dzhng/factory', version: '0.2.0' }))
await Bun.write(${JSON.stringify(executable)}, 'new executable')
`,
  )
  await chmod(join(bin, 'npm'), 0o755)
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    PATH: `${bin}:${process.env.PATH}`,
  }
  return { root, prefix, packageRoot, executable, environment }
}

test('upgrades the running npm prefix, not the default global installation', async () => {
  const value = await fixture()
  const fetchMock = spyOn(globalThis, 'fetch')
  fetchMock.mockResolvedValue(Response.json({ version: '0.2.0' }))
  try {
    const installation = await npmInstallation(value.executable)
    expect(installation).toBeDefined()
    await upgradeNpmInstallation(installation!, value.environment, false, () => {})
    expect(await readFile(value.executable, 'utf8')).toBe('new executable')
    const argv = JSON.parse(await readFile(join(value.environment.HOME, 'argv.json'), 'utf8'))
    expect(argv).toContain(value.prefix)
    expect(argv).toContain('@dzhng/factory@0.2.0')
    expect(argv).toContain('--ignore-scripts')
  } finally {
    fetchMock.mockRestore()
  }
})

test('plain upgrade uses npm through the CLI', async () => {
  const value = await fixture()
  const fetchMock = spyOn(globalThis, 'fetch')
  fetchMock.mockResolvedValue(Response.json({ version: '0.2.0' }))
  const stdout: string[] = []
  const stderr: string[] = []
  try {
    expect(
      await runFactoryCli(['upgrade'], {
        environment: value.environment,
        cwd: value.root,
        runtimeExecutable: value.executable,
        output: { stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      }),
    ).toBe(0)
    expect(await readFile(value.executable, 'utf8')).toBe('new executable')
    expect(stdout.join('')).toContain('upgraded to 0.2.0')
  } finally {
    fetchMock.mockRestore()
  }
})

test('normal startup upgrades, keeps command output, and remains fail-open offline', async () => {
  const value = await fixture()
  const fetchMock = spyOn(globalThis, 'fetch')
  fetchMock.mockResolvedValue(Response.json({ version: '0.2.0' }))
  const stdout: string[] = []
  const stderr: string[] = []
  const options = {
    environment: value.environment,
    cwd: value.root,
    runtimeExecutable: value.executable,
    output: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  }
  try {
    expect(await runFactoryCli(['install', '--executable', value.executable], options)).toBe(0)
    expect(stderr.join('')).toContain('upgraded to 0.2.0')
    expect(await readFile(value.executable, 'utf8')).toBe('new executable')
    expect(JSON.parse(stdout.join('')).executable).toBe(value.executable)
    expect(stderr.join('')).toContain('upgraded to 0.2.0')
    fetchMock.mockRejectedValue(new Error('offline'))
    expect(await runFactoryCli(['install', '--executable', value.executable], options)).toBe(0)
    expect(stderr.join('')).toContain('automatic upgrade skipped')
  } finally {
    fetchMock.mockRestore()
  }
})

test('opt-outs and non-user workers never contact npm', async () => {
  const value = await fixture()
  const fetchMock = spyOn(globalThis, 'fetch')
  fetchMock.mockRejectedValue(new Error('unexpected network'))
  const output = { stdout: () => {}, stderr: () => {} }
  const options = {
    environment: value.environment,
    cwd: value.root,
    runtimeExecutable: value.executable,
    output,
  }
  try {
    await runFactoryCli(['--no-auto-upgrade', 'install', '--executable', value.executable], options)
    await runFactoryCli(['install', '--executable', value.executable], {
      ...options,
      environment: { ...value.environment, FACTORY_NO_AUTO_UPGRADE: '1' },
    })
    for (const args of [
      ['version'],
      ['doctor'],
      ['capture'],
      ['review', '--automatic'],
      ['uninstall'],
      ['configure', '--global', '--update-checks', 'false'],
    ])
      await runFactoryCli(args, options)
    await runFactoryCli(['install', '--executable', value.executable], options)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readFile(value.executable, 'utf8')).toBe('old executable')
  } finally {
    fetchMock.mockRestore()
  }
})

test('check-only, current releases, and older releases never reinstall', async () => {
  const value = await fixture()
  const fetchMock = spyOn(globalThis, 'fetch')
  const output = { stdout: () => {}, stderr: () => {} }
  const options = {
    environment: value.environment,
    cwd: value.root,
    runtimeExecutable: value.executable,
    output,
  }
  try {
    for (const version of ['0.1.0', '0.0.9']) {
      fetchMock.mockResolvedValue(Response.json({ version }))
      expect(await runFactoryCli(['upgrade'], options)).toBe(0)
    }
    fetchMock.mockResolvedValue(Response.json({ version: '0.2.0' }))
    expect(await runFactoryCli(['upgrade', '--check'], options)).toBe(0)
    expect(await readFile(value.executable, 'utf8')).toBe('old executable')
    expect(await Bun.file(join(value.environment.HOME, 'argv.json')).exists()).toBe(false)
  } finally {
    fetchMock.mockRestore()
  }
})

test('local installs are never converted into global installs', async () => {
  const value = await fixture()
  const local = join(value.root, 'node_modules/@dzhng/factory/native/linux-x64-baseline/factory')
  await mkdir(join(local, '..'), { recursive: true })
  await writeFile(local, 'local executable')
  expect(await npmInstallation(local)).toBeUndefined()
})

test('invalid metadata and a failed npm command leave the requested command usable', async () => {
  const value = await fixture()
  const fetchMock = spyOn(globalThis, 'fetch')
  const options = {
    environment: value.environment,
    cwd: value.root,
    runtimeExecutable: value.executable,
    output: { stdout: () => {}, stderr: () => {} },
  }
  try {
    fetchMock.mockResolvedValue(Response.json({ version: 'https://example.com/untrusted.tgz' }))
    expect(await runFactoryCli(['upgrade'], options)).toBe(1)
    expect(await readFile(value.executable, 'utf8')).toBe('old executable')
    await writeFile(join(value.root, 'bin/npm'), '#!/bin/sh\nexit 1\n')
    fetchMock.mockResolvedValue(Response.json({ version: '0.2.0' }))
    expect(await runFactoryCli(['upgrade'], options)).toBe(1)
    expect(await runFactoryCli(['install', '--executable', value.executable], options)).toBe(0)
    expect(await readFile(value.executable, 'utf8')).toBe('old executable')
  } finally {
    fetchMock.mockRestore()
  }
})

test('automatic upgrades do not wait behind another installation', async () => {
  const value = await fixture()
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ version: '0.2.0' }),
  )
  try {
    const installation = await npmInstallation(value.executable)
    await withInstallationLock(value.environment, async () => {
      await expect(
        upgradeNpmInstallation(installation!, value.environment, false, () => {}, true),
      ).rejects.toThrow('lock is unavailable')
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readFile(value.executable, 'utf8')).toBe('old executable')
  } finally {
    fetchMock.mockRestore()
  }
})

test('installation resolves the public registry even with a private scope configured', async () => {
  const value = await fixture()
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ version: '0.2.0' }),
  )
  const npm = Bun.which('npm')
  if (!npm) throw new Error('Docker test image must include npm')
  await writeFile(
    join(value.environment.HOME, '.npmrc'),
    '@dzhng:registry=https://private.example.invalid\n',
  )
  await writeFile(
    join(value.root, 'bin/npm'),
    `#!/usr/bin/env bun
const flags = process.argv.slice(2).filter(arg => arg.startsWith('--registry=') || arg.startsWith('--@dzhng:registry='))
const result = Bun.spawnSync([${JSON.stringify(npm)}, 'config', 'get', '@dzhng:registry', ...flags], { env: process.env })
await Bun.write(process.env.HOME + '/registry.txt', result.stdout)
process.exit(1)
`,
  )
  try {
    await runFactoryCli(['upgrade'], {
      environment: value.environment,
      cwd: value.root,
      runtimeExecutable: value.executable,
      output: { stdout: () => {}, stderr: () => {} },
    })
    expect((await readFile(join(value.environment.HOME, 'registry.txt'), 'utf8')).trim()).toBe(
      'https://registry.npmjs.org',
    )
  } finally {
    fetchMock.mockRestore()
  }
})
