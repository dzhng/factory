import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverSanitizer } from '@factory/sanitization'

import { ConfinedWriter } from '../src/confined-writer'

test('repository discovery applies the shared policy to ignored nested env files without changing them', async () => {
  if (process.env.FACTORY_DOCKER_TEST !== '1') throw new Error('requires Docker test environment')
  const root = await mkdtemp(join(tmpdir(), 'factory-sanitizer-'))
  try {
    await mkdir(join(root, 'ignored'))
    await mkdir(join(root, '.factory'))
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    await writeFile(join(root, 'ignored', '.env.local'), 'VALUE=nested-value\nPASSWORD=pin')
    await writeFile(join(root, '.factory', '.env'), 'VALUE=excluded-value')
    const sanitizer = await discoverSanitizer(bounds => ConfinedWriter.readFiles(root, bounds))
    expect(sanitizer.text('nested-value pin excluded-value').text).toBe(
      '[REDACTED] [REDACTED] excluded-value',
    )
    expect(await readFile(join(root, 'ignored', '.env.local'), 'utf8')).toBe(
      'VALUE=nested-value\nPASSWORD=pin',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
