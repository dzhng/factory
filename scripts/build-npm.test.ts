import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { releaseFixture } from '../packages/cli/test/release-fixture'

test('npm package preserves both verified executables and exposes a factory launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-npm-'))
  try {
    for (const target of ['bun-darwin-arm64', 'bun-linux-x64-baseline'] as const) {
      const fixture = await releaseFixture({ target })
      const stem = `factory-v${fixture.identity.version}-${target.slice(4)}`
      await writeFile(join(root, `${stem}.tar.gz`), fixture.archive)
      await writeFile(join(root, `${stem}.json`), fixture.adjacentManifest)
    }
    const output = join(root, 'package')
    const child = Bun.spawn(
      [
        'bun',
        'scripts/build-npm.ts',
        '--version',
        '0.1.0-test.1',
        '--revision',
        'a'.repeat(40),
        '--artifacts',
        root,
        '--output',
        output,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
    const manifest = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('@dzhng/factory')
    expect(manifest.bin).toEqual({ factory: 'bin/factory.cjs' })
    expect(manifest.scripts).toBeUndefined()
    for (const platform of ['darwin-arm64', 'linux-x64-baseline']) {
      const binary = join(output, 'native', platform, 'factory')
      expect(await readFile(binary, 'utf8')).toBe('test executable')
      expect((await stat(binary)).mode & 0o777).toBe(0o755)
    }
    const rejected = Bun.spawn(
      [
        'bun',
        'scripts/build-npm.ts',
        '--version',
        '0.1.0-test.1',
        '--revision',
        'b'.repeat(40),
        '--artifacts',
        root,
        '--output',
        join(root, 'wrong'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const rejection = await new Response(rejected.stderr).text()
    expect(await rejected.exited).toBe(1)
    expect(rejection).toContain('npm package and native release identity mismatch')
    expect(await Bun.file(join(root, 'wrong/package.json')).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
