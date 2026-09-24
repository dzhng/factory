import { expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createReleaseArchive } from './release-archive'

test('release archive preserves exact bytes and executable mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-release-archive-'))
  try {
    await writeFile(join(root, 'factory'), 'binary', { mode: 0o755 })
    await writeFile(join(root, 'LICENSE'), 'license', { mode: 0o644 })
    const archive = createReleaseArchive(root, ['factory', 'LICENSE'])
    const parsed = new Bun.Archive(archive)
    const files = await parsed.files()
    expect(await files.get('factory')?.text()).toBe('binary')
    expect(await files.get('LICENSE')?.text()).toBe('license')
    const output = join(root, 'unpacked')
    await parsed.extract(output)
    expect((await stat(join(output, 'factory'))).mode & 0o777).toBe(0o755)
    expect((await stat(join(output, 'LICENSE'))).mode & 0o777).toBe(0o644)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
