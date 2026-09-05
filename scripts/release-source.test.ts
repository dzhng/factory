import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { verifiedSourceRevision } from './release-source'

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stderr: 'pipe', stdout: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

async function repository(): Promise<{ root: string; revision: string }> {
  const root = await mkdtemp(join(tmpdir(), 'factory-release-source-'))
  git(root, 'init', '--quiet')
  await writeFile(join(root, 'source.ts'), 'export const value = 1\n')
  git(root, 'add', 'source.ts')
  git(
    root,
    '-c',
    'user.name=Factory Tests',
    '-c',
    'user.email=factory@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  )
  return { root, revision: git(root, 'rev-parse', 'HEAD') }
}

describe('release source identity', () => {
  test('reads identity from the named checkout rather than the caller repository', async () => {
    const value = await repository()
    try {
      expect(verifiedSourceRevision(value.root)).toBe(value.revision)
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })

  test('rejects a requested revision that is not the compiled checkout', async () => {
    const value = await repository()
    try {
      expect(() => verifiedSourceRevision(value.root, 'b'.repeat(40))).toThrow('does not match')
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })

  test('rejects dirty and untracked source', async () => {
    const value = await repository()
    try {
      await writeFile(join(value.root, 'untracked.ts'), 'secret\n')
      expect(() => verifiedSourceRevision(value.root, value.revision)).toThrow('clean worktree')
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  })
})
