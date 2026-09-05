import { expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createReleaseArchive } from './release-archive'

test('release archive preserves exact bytes and executable mode', async () => {
  const archive = createReleaseArchive([
    { name: 'factory', bytes: new TextEncoder().encode('binary'), mode: 0o755 },
    { name: 'LICENSE', bytes: new TextEncoder().encode('license'), mode: 0o644 },
  ])
  const parsed = new Bun.Archive(archive)
  const files = await parsed.files()
  expect(await files.get('factory')?.text()).toBe('binary')
  const root = await mkdtemp(join(tmpdir(), 'factory-release-archive-'))
  try {
    await parsed.extract(root)
    expect((await stat(join(root, 'factory'))).mode & 0o777).toBe(0o755)
    expect((await stat(join(root, 'LICENSE'))).mode & 0o777).toBe(0o644)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
