import { expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runFactoryCli } from '../src'
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

test('background checks cache a notice without installing and rate-limit repeated launches', async () => {
  const value = await fixture()
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ version: '0.2.0' }),
  )
  const stderr: string[] = []
  const options = {
    environment: value.environment,
    cwd: value.root,
    runtimeExecutable: value.executable,
    interactive: true,
    output: { stdout: () => {}, stderr: (text: string) => stderr.push(text) },
  }
  try {
    expect(await runFactoryCli(['_update-check', 'npm'], options)).toBe(0)
    expect(await runFactoryCli(['_update-check', 'npm'], options)).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await runFactoryCli(['install', '--executable', value.executable], options)).toBe(0)
    expect(stderr.join('')).toBe('Factory 0.2.0 is available. Run factory upgrade.\n')
    expect(await readFile(value.executable, 'utf8')).toBe('old executable')
  } finally {
    fetchMock.mockRestore()
  }
})

test('interactive commands finish while a detached checker is still waiting', async () => {
  const value = await fixture()
  const release = join(value.environment.HOME, 'release-checker')
  const done = join(value.environment.HOME, 'checker-done')
  await writeFile(
    value.executable,
    `#!/bin/sh
while [ ! -f "${release}" ]; do sleep 0.01; done
printf '%s' "$1 $2" > "${done}"
`,
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      runFactoryCli(['install', '--executable', value.executable], {
        environment: value.environment,
        cwd: value.root,
        runtimeExecutable: value.executable,
        interactive: true,
        output: { stdout: () => {}, stderr: () => {} },
      }),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('blocked by checker'), 2000)
      }),
    ])
    expect(result).toBe(0)
  } finally {
    clearTimeout(timer)
    await writeFile(release, '')
  }
  const deadline = Date.now() + 2000
  while (!(await Bun.file(done).exists()) && Date.now() < deadline) await Bun.sleep(10)
  expect(await readFile(done, 'utf8')).toBe('_update-check npm')
})

test('failed checks preserve a usable notice and suppress repeated network attempts', async () => {
  const value = await fixture()
  const cache = join(value.environment.HOME, '.cache/factory/npm-update-check.json')
  await mkdir(join(cache, '..'), { recursive: true })
  await writeFile(
    cache,
    JSON.stringify({ checkedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, version: '0.2.0' }),
  )
  const fetchMock = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
  const stderr: string[] = []
  const options = {
    environment: value.environment,
    cwd: value.root,
    runtimeExecutable: value.executable,
    interactive: true,
    output: { stdout: () => {}, stderr: (text: string) => stderr.push(text) },
  }
  try {
    await runFactoryCli(['_update-check', 'npm'], options)
    await runFactoryCli(['_update-check', 'npm'], options)
    await runFactoryCli(['install', '--executable', value.executable], options)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(stderr.join('')).toContain('Run factory upgrade.')
    expect(JSON.parse(await readFile(cache, 'utf8')).version).toBe('0.2.0')
    stderr.length = 0
    await runFactoryCli(['install', '--executable', value.executable], {
      ...options,
      interactive: false,
    })
    await runFactoryCli(['capture'], options)
    await runFactoryCli(['review', '--automatic'], options)
    expect(stderr.join('')).not.toContain('Run factory upgrade.')
  } finally {
    fetchMock.mockRestore()
  }
})

test('disabling checks does not itself display a notice', async () => {
  const value = await fixture()
  const cache = join(value.environment.HOME, '.cache/factory/npm-update-check.json')
  await mkdir(join(cache, '..'), { recursive: true })
  await writeFile(cache, JSON.stringify({ checkedAt: Date.now(), version: '0.2.0' }))
  const stderr: string[] = []
  const options = {
    environment: value.environment,
    cwd: value.root,
    runtimeExecutable: value.executable,
    interactive: true,
    output: { stdout: () => {}, stderr: (text: string) => stderr.push(text) },
  }
  expect(await runFactoryCli(['configure', '--global', '--update-checks', 'false'], options)).toBe(
    0,
  )
  expect(await runFactoryCli(['install', '--executable', value.executable], options)).toBe(0)
  expect(stderr.join('')).toBe('')
})

test('normal startup never installs or checks in a noninteractive invocation', async () => {
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
    expect(await readFile(value.executable, 'utf8')).toBe('old executable')
    expect(JSON.parse(stdout.join('')).executable).toBe(value.executable)
    expect(stderr.join('')).toBe('')
    fetchMock.mockRejectedValue(new Error('offline'))
    expect(await runFactoryCli(['install', '--executable', value.executable], options)).toBe(0)
    expect(stderr.join('')).toBe('')
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
