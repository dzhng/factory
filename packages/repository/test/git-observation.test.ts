import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as filesystem from 'node:fs/promises'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalJson, decodeGitPath } from '../../contract/src/index'
import { GitObserver, reconstructCodeManifest } from '../src/git-observer'
import { MemoryGitObjectStore } from './git-object-store'

if (process.env.FACTORY_DOCKER_TEST !== '1') {
  throw new Error('Git observation tests must run in the project Docker test environment')
}

const roots: string[] = []

async function run(root: string, args: readonly string[]): Promise<void> {
  const process = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`)
}

async function runExpectingFailure(root: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if ((await child.exited) === 0) throw new Error(`git ${args.join(' ')} unexpectedly succeeded`)
}

async function gitOutput(root: string, args: readonly string[]): Promise<Uint8Array> {
  const child = Bun.spawn(['git', ...args], {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`)
  return new Uint8Array(stdout)
}

async function fixtureSentinel(root: string, paths: readonly string[]): Promise<string> {
  const state = createHash('sha256')
  for (const args of [
    ['rev-parse', 'HEAD'],
    ['symbolic-ref', '-q', 'HEAD'],
    ['for-each-ref', '--format=%(refname)%00%(objectname)'],
    ['config', '--local', '--null', '--list'],
  ]) {
    state.update(await gitOutput(root, args))
  }
  state.update(await readFile(join(root, '.git', 'index')))
  for (const path of paths) {
    const entry = await lstat(join(root, path))
    state
      .update(path)
      .update(String(entry.mode))
      .update(await readFile(join(root, path)))
  }
  return state.digest('hex')
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'factory-git-observation-'))
  roots.push(root)
  await run(root, ['init', '--quiet'])
  await run(root, ['config', 'user.name', 'Factory Test'])
  await run(root, ['config', 'user.email', 'factory@example.invalid'])
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.serial('safe Git observation', () => {
  test('reconstructs tracked and untracked bytes and executable modes without mutating Git', async () => {
    const root = await repository()
    await writeFile(join(root, 'tracked.bin'), new Uint8Array([0, 255, 10]))
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(root, 'run.sh'), 0o755)
    await run(root, ['add', '--', 'tracked.bin', 'run.sh'])
    await run(root, ['commit', '--quiet', '-m', 'fixture'])
    await writeFile(join(root, 'untracked.txt'), 'untracked\n')
    await writeFile(join(root, 'other-exec.txt'), 'not owner executable\n')
    await chmod(join(root, 'other-exec.txt'), 0o641)
    await writeFile(join(root, 'other-exec-2.txt'), 'also not owner executable\n')
    await chmod(join(root, 'other-exec-2.txt'), 0o601)
    const fixturePaths = [
      'other-exec-2.txt',
      'other-exec.txt',
      'run.sh',
      'tracked.bin',
      'untracked.txt',
    ]
    const before = await fixtureSentinel(root, fixturePaths)

    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, { repositoryId: 'repo_test' })
    const result = await observer.observe()
    if (result.kind === 'unavailable') throw new Error(result.reason.detail)
    expect(result.kind).toBe('observed')
    if (result.kind !== 'observed') throw new Error('expected an exact observation')
    const manifest = await objects.readJson(result.observation.codeManifest!)
    const destination = await mkdtemp(join(tmpdir(), 'factory-reconstruction-'))
    roots.push(destination)
    await observer.reconstruct(manifest, destination)

    const portableDestination = await mkdtemp(join(tmpdir(), 'factory-portable-reconstruction-'))
    roots.push(portableDestination)
    await reconstructCodeManifest(manifest, portableDestination, reference =>
      objects.get(reference),
    )

    expect(await readFile(join(destination, 'tracked.bin'))).toEqual(Buffer.from([0, 255, 10]))
    expect(await readFile(join(destination, 'untracked.txt'), 'utf8')).toBe('untracked\n')
    expect((await lstat(join(destination, 'run.sh'))).mode & 0o111).not.toBe(0)
    expect((await lstat(join(destination, 'other-exec.txt'))).mode & 0o777).toBe(0o644)
    expect((await lstat(join(destination, 'other-exec-2.txt'))).mode & 0o777).toBe(0o644)
    expect((await lstat(join(destination, 'tracked.bin'))).mode & 0o777).toBe(0o644)
    expect(await fixtureSentinel(root, fixturePaths)).toBe(before)
    await expect(lstat(join(destination, '.git'))).rejects.toThrow()
    expect(await readFile(join(portableDestination, 'tracked.bin'))).toEqual(
      Buffer.from([0, 255, 10]),
    )
    await expect(lstat(join(portableDestination, '.git'))).rejects.toThrow()
    expect(
      manifest.entries.map(entry => Buffer.from(decodeGitPath(entry.path)).toString()),
    ).toEqual(['other-exec-2.txt', 'other-exec.txt', 'run.sh', 'tracked.bin', 'untracked.txt'])
  })

  test('keeps non-UTF-8 path bytes authoritative and excludes ignored files visibly', async () => {
    const root = await repository()
    const rawName = Buffer.from([0x72, 0x61, 0x77, 0xff])
    await writeFile(Buffer.concat([Buffer.from(`${root}/`), rawName]), 'bytes\n')
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(root, 'ignored.txt'), 'not code\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'byte path'])

    const objects = new MemoryGitObjectStore()
    const result = await new GitObserver(root, objects, { repositoryId: 'repo_test' }).observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    expect(
      manifest.entries.some(entry => Buffer.from(decodeGitPath(entry.path)).equals(rawName)),
    ).toBe(true)
    expect(manifest.entries.some(entry => entry.path.display?.includes('\ufffd'))).toBe(false)
    expect(manifest.entries.some(entry => entry.path.display === 'ignored.txt')).toBe(false)
    expect(manifest.limitations).toContainEqual(
      expect.objectContaining({ detail: '1 ignored path(s) excluded' }),
    )
  })

  test('honors the developer global ignore file without enabling executable Git config', async () => {
    const root = await repository()
    const home = await mkdtemp(join(tmpdir(), 'factory-git-home-'))
    roots.push(home)
    const excludes = join(home, 'global-ignore')
    await writeFile(excludes, 'secret.local\n')
    await writeFile(join(home, '.gitconfig'), `[core]\n\texcludesFile = ${excludes}\n`)
    await writeFile(join(root, 'secret.local'), 'not review input\n')
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      const objects = new MemoryGitObjectStore()
      const result = await new GitObserver(root, objects, { repositoryId: 'repo_test' }).observe()
      if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
      const manifest = await objects.readJson(result.observation.codeManifest!)
      expect(manifest.entries.some(entry => entry.path.display === 'secret.local')).toBe(false)
      expect(manifest.limitations).toContainEqual(
        expect.objectContaining({ detail: '1 ignored path(s) excluded' }),
      )
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
  })

  test('preserves safe links but rejects escaping and cyclic reconstruction', async () => {
    const root = await repository()
    await writeFile(join(root, 'target.txt'), 'target\n')
    await symlink('target.txt', join(root, 'safe-link'))
    await symlink('../outside', join(root, 'unsafe-link'))
    await mkdir(join(root, 'nested'))
    await symlink('..', join(root, 'nested', 'parent-loop'))
    await symlink('.', join(root, 'nested', 'self-loop'))
    await symlink('cycle-b', join(root, 'cycle-a'))
    await symlink('cycle-a', join(root, 'cycle-b'))
    await symlink('descendant-loop/child', join(root, 'descendant-loop'))
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'links'])

    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, { repositoryId: 'repo_test' })
    const result = await observer.observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    expect(manifest.entries.filter(entry => entry.kind === 'symlink')).toHaveLength(7)
    expect(manifest.limitations.map(item => item.detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unsafe symlink'),
        expect.stringContaining('cyclic symlink'),
      ]),
    )
    const destination = await mkdtemp(join(tmpdir(), 'factory-links-'))
    roots.push(destination)
    await expect(observer.reconstruct(manifest, destination)).rejects.toThrow('cyclic symlink')

    const safeManifest = {
      ...manifest,
      entries: manifest.entries.filter(entry =>
        ['safe-link', 'target.txt'].includes(entry.path.display ?? ''),
      ),
      limitations: [],
    }
    await observer.reconstruct(safeManifest, destination)
    expect(await readlink(join(destination, 'safe-link'))).toBe('target.txt')
    const empty = await mkdtemp(join(tmpdir(), 'factory-link-destination-'))
    roots.push(empty)
    const destinationLink = join(root, 'reconstruction-link')
    await symlink(empty, destinationLink)
    await expect(observer.reconstruct(safeManifest, destinationLink)).rejects.toThrow(
      'destination cannot be a symbolic link',
    )
    const metadataDestination = join(root, '.git', 'factory-reconstruction-test')
    await mkdir(metadataDestination)
    await expect(observer.reconstruct(safeManifest, metadataDestination)).rejects.toThrow(
      'cannot enter Git metadata',
    )
  })

  test('returns a typed race when workspace bytes change inside the observation window', async () => {
    const root = await repository()
    await writeFile(join(root, 'source.ts'), 'before\n')
    await run(root, ['add', 'source.ts'])
    await run(root, ['commit', '--quiet', '-m', 'source'])
    const result = await new GitObserver(root, new MemoryGitObjectStore(), {
      repositoryId: 'repo_test',
      afterCapture: async () => writeFile(join(root, 'source.ts'), 'after\n'),
    }).observe()
    expect(result.kind).toBe('raced')
    if (result.kind !== 'raced') throw new Error('race was not detected')
    expect(result.race.startState).not.toBe(result.race.endState)
    expect(result.partial.limitations).toContainEqual(
      expect.objectContaining({ code: 'repository-race' }),
    )
  })

  test('keeps reconstruction confined when the destination path is swapped', async () => {
    const root = await repository()
    await writeFile(join(root, 'source.txt'), 'confined\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'confined'])
    const destination = await mkdtemp(join(tmpdir(), 'factory-confined-'))
    const moved = `${destination}-moved`
    const outside = await mkdtemp(join(tmpdir(), 'factory-confined-outside-'))
    roots.push(destination, moved, outside)
    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, {
      repositoryId: 'repo_test',
      beforeReconstructionWrite: async () => {
        await rename(destination, moved)
        await symlink(outside, destination)
      },
    })
    const result = await observer.observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    await expect(observer.reconstruct(manifest, destination)).rejects.toThrow(
      'destination changed while writing',
    )
    await expect(lstat(join(outside, 'source.txt'))).rejects.toThrow()
    expect(await readFile(join(moved, 'source.txt'), 'utf8')).toBe('confined\n')
  })

  test('rejects an entry injected after descriptor binding instead of accepting an inexact tree', async () => {
    const root = await repository()
    await writeFile(join(root, 'source.txt'), 'confined\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'confined'])
    const destination = await mkdtemp(join(tmpdir(), 'factory-exact-tree-'))
    const outside = await mkdtemp(join(tmpdir(), 'factory-exact-tree-outside-'))
    roots.push(destination, outside)
    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, {
      repositoryId: 'repo_test',
      beforeReconstructionWrite: async () => symlink(outside, join(destination, 'injected')),
    })
    const result = await observer.observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)

    await expect(observer.reconstruct(manifest, destination)).rejects.toThrow(
      'destination changed before writing',
    )
    expect((await lstat(join(destination, 'injected'))).isSymbolicLink()).toBe(true)
    await expect(lstat(join(destination, 'source.txt'))).rejects.toThrow()
  })

  test('leaves a disposable partial destination when a later object fails verification', async () => {
    const root = await repository()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'first.txt'), 'first\n')
    await writeFile(join(root, 'nested', 'second.txt'), 'second\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'cleanup'])
    const destination = await mkdtemp(join(tmpdir(), 'factory-cleanup-'))
    roots.push(destination)
    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, { repositoryId: 'repo_test' })
    const result = await observer.observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    const later = manifest.entries.at(-1)
    if (later === undefined || !('object' in later))
      throw new Error('fixture requires a later object')
    const laterObject = later.object
    const reconstructing = new GitObserver(
      root,
      {
        put: (bytes, metadata) => objects.put(bytes, metadata),
        get: ref =>
          ref.sha256 === laterObject.sha256
            ? Promise.resolve(new Uint8Array(ref.bytes))
            : objects.get(ref),
      },
      { repositoryId: 'repo_test' },
    )

    await expect(reconstructing.reconstruct(manifest, destination)).rejects.toThrow(
      'unavailable or corrupt',
    )
    expect(await readFile(join(destination, 'nested', 'first.txt'), 'utf8')).toBe('first\n')
    await expect(lstat(join(destination, 'nested', 'second.txt'))).rejects.toThrow()
  })

  test('preserves a foreign special-file replacement in a failed destination', async () => {
    const root = await repository()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'first.txt'), 'first\n')
    await writeFile(join(root, 'nested', 'second.txt'), 'second\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'replacement'])
    const destination = await mkdtemp(join(tmpdir(), 'factory-replacement-'))
    roots.push(destination)
    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, { repositoryId: 'repo_test' })
    const result = await observer.observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    const later = manifest.entries.at(-1)
    if (later === undefined || !('object' in later))
      throw new Error('fixture requires a later object')
    let replaced = false
    const reconstructing = new GitObserver(
      root,
      {
        put: (bytes, metadata) => objects.put(bytes, metadata),
        get: async ref => {
          if (ref.sha256 === later.object.sha256 && !replaced) {
            const first = join(destination, 'nested', 'first.txt')
            await unlink(first)
            const fifo = Bun.spawn(['mkfifo', first], { stdout: 'pipe', stderr: 'pipe' })
            if ((await fifo.exited) !== 0) throw new Error('cannot create FIFO fixture')
            replaced = true
          }
          return objects.get(ref)
        },
      },
      { repositoryId: 'repo_test' },
    )

    await expect(reconstructing.reconstruct(manifest, destination)).rejects.toThrow(
      'special filesystem entry',
    )
    expect((await lstat(join(destination, 'nested', 'first.txt'))).isFIFO()).toBe(true)
    expect(await readFile(join(destination, 'nested', 'second.txt'), 'utf8')).toBe('second\n')
  })

  test('rejects changed file bytes without deleting the foreign replacement', async () => {
    const root = await repository()
    await writeFile(join(root, 'first.txt'), 'first\n')
    await writeFile(join(root, 'second.txt'), 'second\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'replacement bytes'])
    const destination = await mkdtemp(join(tmpdir(), 'factory-replacement-bytes-'))
    roots.push(destination)
    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, { repositoryId: 'repo_test' })
    const result = await observer.observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    const later = manifest.entries.at(-1)
    if (later === undefined || !('object' in later))
      throw new Error('fixture requires a later object')
    let replaced = false
    const reconstructing = new GitObserver(
      root,
      {
        put: (bytes, metadata) => objects.put(bytes, metadata),
        get: async ref => {
          if (ref.sha256 === later.object.sha256 && !replaced) {
            const first = join(destination, 'first.txt')
            await unlink(first)
            await writeFile(first, 'other\n')
            replaced = true
          }
          return objects.get(ref)
        },
      },
      { repositoryId: 'repo_test' },
    )

    await expect(reconstructing.reconstruct(manifest, destination)).rejects.toThrow(
      'does not exactly match',
    )
    expect(await readFile(join(destination, 'first.txt'), 'utf8')).toBe('other\n')
    expect(await readFile(join(destination, 'second.txt'), 'utf8')).toBe('second\n')
  })

  test('rejects a foreign replacement even when its mode and bytes match', async () => {
    const root = await repository()
    await writeFile(join(root, 'first.txt'), 'first\n')
    await writeFile(join(root, 'second.txt'), 'second\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'replacement identity'])
    const destination = await mkdtemp(join(tmpdir(), 'factory-replacement-identity-'))
    roots.push(destination)
    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, { repositoryId: 'repo_test' })
    const result = await observer.observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    const later = manifest.entries.at(-1)
    if (later === undefined || !('object' in later))
      throw new Error('fixture requires a later object')
    let replaced = false
    const reconstructing = new GitObserver(
      root,
      {
        put: (bytes, metadata) => objects.put(bytes, metadata),
        get: async ref => {
          if (ref.sha256 === later.object.sha256 && !replaced) {
            const first = join(destination, 'first.txt')
            await unlink(first)
            await writeFile(first, 'first\n', { mode: 0o644 })
            replaced = true
          }
          return objects.get(ref)
        },
      },
      { repositoryId: 'repo_test' },
    )

    await expect(reconstructing.reconstruct(manifest, destination)).rejects.toThrow(
      'does not exactly match',
    )
    expect(await readFile(join(destination, 'first.txt'), 'utf8')).toBe('first\n')
  })

  test('rejects an injected oversized file before final inventory buffers it', async () => {
    const root = await repository()
    await writeFile(join(root, 'first.txt'), 'first\n')
    await writeFile(join(root, 'second.txt'), 'second\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'bounded inventory'])
    const destination = await mkdtemp(join(tmpdir(), 'factory-inventory-limit-'))
    roots.push(destination)
    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, { repositoryId: 'repo_test' })
    const result = await observer.observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    const later = manifest.entries.at(-1)
    if (later === undefined || !('object' in later))
      throw new Error('fixture requires a later object')
    let expanded = false
    const reconstructing = new GitObserver(
      root,
      {
        put: (bytes, metadata) => objects.put(bytes, metadata),
        get: async ref => {
          if (ref.sha256 === later.object.sha256 && !expanded) {
            await truncate(join(destination, 'first.txt'), 512 * 1024 * 1024)
            expanded = true
          }
          return objects.get(ref)
        },
      },
      { repositoryId: 'repo_test' },
    )

    await expect(reconstructing.reconstruct(manifest, destination)).rejects.toThrow(
      'manifest byte limits',
    )
    expect((await lstat(join(destination, 'first.txt'))).size).toBe(512 * 1024 * 1024)
  })

  test('rejects any changed permission bits in the final exact tree', async () => {
    const root = await repository()
    await writeFile(join(root, 'first.txt'), 'first\n')
    await writeFile(join(root, 'second.txt'), 'second\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'exact mode'])
    const destination = await mkdtemp(join(tmpdir(), 'factory-exact-mode-'))
    roots.push(destination)
    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, { repositoryId: 'repo_test' })
    const result = await observer.observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    const later = manifest.entries.at(-1)
    if (later === undefined || !('object' in later))
      throw new Error('fixture requires a later object')
    let changed = false
    const reconstructing = new GitObserver(
      root,
      {
        put: (bytes, metadata) => objects.put(bytes, metadata),
        get: async ref => {
          if (ref.sha256 === later.object.sha256 && !changed) {
            await chmod(join(destination, 'first.txt'), 0o744)
            changed = true
          }
          return objects.get(ref)
        },
      },
      { repositoryId: 'repo_test' },
    )

    await expect(reconstructing.reconstruct(manifest, destination)).rejects.toThrow(
      'does not exactly match',
    )
  })

  test('copies verified symlink bytes before an object-store buffer can change', async () => {
    const root = await repository()
    await writeFile(join(root, 'safe-target'), 'target\n')
    await symlink('safe-target', join(root, 'safe-link'))
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'link buffer'])
    const destination = await mkdtemp(join(tmpdir(), 'factory-link-buffer-'))
    roots.push(destination)
    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, { repositoryId: 'repo_test' })
    const result = await observer.observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    const link = manifest.entries.find(entry => entry.kind === 'symlink')
    if (link === undefined) throw new Error('fixture requires a symlink')
    const shared = await objects.get(link.object)
    const reconstructing = new GitObserver(
      root,
      {
        put: (bytes, metadata) => objects.put(bytes, metadata),
        get: ref =>
          ref.sha256 === link.object.sha256 ? Promise.resolve(shared) : objects.get(ref),
      },
      {
        repositoryId: 'repo_test',
        beforeReconstructionWrite: async () => {
          shared.set(Buffer.from('/etc/passwd'))
        },
      },
    )

    await reconstructing.reconstruct(manifest, destination)
    expect(await readlink(join(destination, 'safe-link'))).toBe('safe-target')
  })

  test('refuses a symlinked ancestor without publishing outside bytes', async () => {
    const root = await repository()
    await mkdir(join(root, 'dir'))
    await writeFile(join(root, 'dir', 'secret'), 'inside\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'ancestor'])
    await rm(join(root, 'dir'), { recursive: true })
    const outside = await mkdtemp(join(tmpdir(), 'factory-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret'), 'outside secret\n')
    await symlink(outside, join(root, 'dir'))
    const memory = new MemoryGitObjectStore()
    const publications: Uint8Array[] = []
    const result = await new GitObserver(
      root,
      {
        put: async (bytes, metadata) => {
          publications.push(bytes.slice())
          return memory.put(bytes, metadata)
        },
        get: ref => memory.get(ref),
      },
      { repositoryId: 'repo_test' },
    ).observe()
    expect(result.kind).toBe('observed')
    expect(
      publications.some(bytes => Buffer.from(bytes).equals(Buffer.from('outside secret\n'))),
    ).toBe(false)
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    expect(result.observation.limitations).toContainEqual(
      expect.objectContaining({ detail: expect.stringContaining('unreadable workspace path') }),
    )
  })

  test('does not publish captured objects until the ending sentinel is ready', async () => {
    const root = await repository()
    await writeFile(join(root, 'source.ts'), 'source\n')
    await run(root, ['add', 'source.ts'])
    await run(root, ['commit', '--quiet', '-m', 'source'])
    const memory = new MemoryGitObjectStore()
    let publications = 0
    const result = await new GitObserver(
      root,
      {
        put: async (bytes, metadata) => {
          publications += 1
          return memory.put(bytes, metadata)
        },
        get: ref => memory.get(ref),
      },
      {
        repositoryId: 'repo_test',
        afterCapture: async () => expect(publications).toBe(0),
      },
    ).observe()
    expect(result.kind).toBe('observed')
    expect(publications).toBeGreaterThan(0)
  })

  test('retains exact admitted bytes across multiple read chunks', async () => {
    const root = await repository()
    const bytes = Buffer.concat([
      Buffer.alloc(64 * 1024, 1),
      Buffer.alloc(64 * 1024, 2),
      Buffer.from('tail'),
    ])
    await writeFile(join(root, 'source.bin'), bytes)
    const objects = new MemoryGitObjectStore()
    const result = await new GitObserver(root, objects, { repositoryId: 'repo_test' }).observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    const entry = manifest.entries[0]!
    if (!('object' in entry)) throw new Error('fixture must capture an ordinary file')
    expect(Buffer.from(await objects.get(entry.object)).equals(bytes)).toBe(true)
  })

  test('excludes oversized files without reading their content in capture or race sentinels', async () => {
    const root = await repository()
    await writeFile(join(root, 'readable.txt'), 'readable\n')
    await writeFile(join(root, 'oversized.bin'), '')
    await truncate(join(root, 'oversized.bin'), 64 * 1024 * 1024)
    const readBytes = async () => {
      const counters = await readFile('/proc/self/io', 'utf8')
      return Number(/^rchar: (\d+)$/m.exec(counters)![1])
    }
    const objects = new MemoryGitObjectStore()
    const before = await readBytes()
    const result = await new GitObserver(root, objects, {
      repositoryId: 'repo_test',
      maxFileBytes: 16,
    }).observe()
    const consumed = (await readBytes()) - before
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    expect(manifest.entries.map(entry => entry.path.display)).toEqual(['readable.txt'])
    expect(manifest.limitations).toContainEqual(
      expect.objectContaining({
        code: 'excluded-by-limit',
        detail: expect.stringContaining('file exceeds 16'),
      }),
    )
    // Process-wide read accounting includes Git output and runtime overhead. The
    // allowance dwarfs that overhead but cannot hide even one oversized-file scan.
    expect(consumed).toBeLessThan(1024 * 1024)
  })

  test('detects replacement of excluded bytes during the observation window', async () => {
    const root = await repository()
    const path = join(root, 'oversized.bin')
    await writeFile(path, 'before')
    const result = await new GitObserver(root, new MemoryGitObjectStore(), {
      repositoryId: 'repo_test',
      maxFileBytes: 1,
      afterCapture: async () => {
        await unlink(path)
        await writeFile(path, 'after!')
      },
    }).observe()
    expect(result.kind).toBe('raced')
    if (result.kind !== 'raced') throw new Error('excluded-path race was not detected')
    expect(result.race.startState).not.toBe(result.race.endState)
    expect(result.partial.limitations).toContainEqual(
      expect.objectContaining({ code: 'repository-race' }),
    )
  })

  test('bounds content reads when a file grows after its descriptor metadata was sampled', async () => {
    const root = await repository()
    const path = join(root, 'growing.bin')
    await writeFile(path, 'small')
    const readBytes = async () =>
      Number(/^rchar: (\d+)$/m.exec(await readFile('/proc/self/io', 'utf8'))![1])
    const originalOpen = filesystem.open
    let grew = false
    const opened = spyOn(filesystem, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === path) {
        const originalStat = handle.stat
        spyOn(handle, 'stat').mockImplementation(
          new Proxy(originalStat, {
            apply: async (stat, receiver, statArgs) => {
              const state = await Reflect.apply(stat, receiver, statArgs)
              if (!grew) {
                grew = true
                await truncate(path, 64 * 1024 * 1024)
              }
              return state
            },
          }),
        )
      }
      return handle
    })
    try {
      const before = await readBytes()
      const result = await new GitObserver(root, new MemoryGitObjectStore(), {
        repositoryId: 'repo_test',
        maxFileBytes: 16,
      }).observe()
      expect(result.kind).toBe('raced')
      expect((await readBytes()) - before).toBeLessThan(1024 * 1024)
    } finally {
      opened.mockRestore()
    }
  })

  test('does not invent a content change for a clean tracked file excluded by size', async () => {
    const root = await repository()
    await writeFile(join(root, 'oversized.bin'), 'unchanged tracked bytes')
    await run(root, ['add', 'oversized.bin'])
    await run(root, ['commit', '--quiet', '-m', 'tracked'])
    const result = await new GitObserver(root, new MemoryGitObjectStore(), {
      repositoryId: 'repo_test',
      maxFileBytes: 16,
    }).observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    expect(result.observation.changedPaths).toEqual([])
    expect(result.observation.limitations).toContainEqual(
      expect.objectContaining({ code: 'excluded-by-limit' }),
    )
  })

  test('bounds the aggregate captured workspace instead of accumulating without limit', async () => {
    const root = await repository()
    await writeFile(join(root, 'a.bin'), new Uint8Array(8))
    await writeFile(join(root, 'b.bin'), new Uint8Array(8))
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'aggregate'])
    const objects = new MemoryGitObjectStore()
    const result = await new GitObserver(root, objects, {
      repositoryId: 'repo_test',
      maxObservationBytes: 10,
    }).observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    expect(manifest.entries.map(entry => entry.path.display)).toEqual(['a.bin'])
    expect(manifest.limitations).toContainEqual(
      expect.objectContaining({
        code: 'excluded-by-limit',
        detail: expect.stringContaining('workspace exceeds 10'),
      }),
    )
  })

  test('loads code manifests only from canonical verified manifest objects', async () => {
    const root = await repository()
    const objects = new MemoryGitObjectStore()
    const observer = new GitObserver(root, objects, { repositoryId: 'repo_test' })
    const value = { schemaVersion: 1 as const, entries: [], limitations: [] }
    const valid = await objects.put(new TextEncoder().encode(canonicalJson(value)), {
      mediaType: 'application/vnd.factory.code-manifest+json',
      role: 'workspace-code-manifest',
    })
    expect(await observer.loadCodeManifest(valid)).toEqual(value)
    const noncanonical = await objects.put(new TextEncoder().encode(JSON.stringify(value)), {
      mediaType: 'application/vnd.factory.code-manifest+json',
      role: 'workspace-code-manifest',
    })
    await expect(observer.loadCodeManifest(noncanonical)).rejects.toThrow('not canonical JSON')
    await expect(observer.loadCodeManifest({ ...valid, role: 'workspace-file' })).rejects.toThrow(
      'does not identify',
    )
    await expect(observer.loadCodeManifest({ ...valid, sha256: '0'.repeat(64) })).rejects.toThrow(
      'unavailable or corrupt',
    )
    const invalidUtf8 = await objects.put(new Uint8Array([0xff]), {
      mediaType: 'application/vnd.factory.code-manifest+json',
      role: 'workspace-code-manifest',
    })
    await expect(observer.loadCodeManifest(invalidUtf8)).rejects.toThrow()
  })

  test('returns a typed unavailable result before buffering oversized Git output', async () => {
    const root = await repository()
    await writeFile(join(root, 'source'), 'source')
    await run(root, ['add', 'source'])
    await run(root, ['commit', '--quiet', '-m', 'source'])
    const result = await new GitObserver(root, new MemoryGitObjectStore(), {
      repositoryId: 'repo_test',
      maxGitOutputBytes: 8,
    }).observe()
    expect(result).toMatchObject({ kind: 'unavailable', reason: { code: 'git-output-limit' } })
  })

  test('observes unborn and detached HEAD without inventing branch identity', async () => {
    const unborn = await repository()
    await writeFile(join(unborn, 'new.txt'), 'new\n')
    const unbornResult = await new GitObserver(unborn, new MemoryGitObjectStore(), {
      repositoryId: 'repo_test',
    }).observe()
    if (unbornResult.kind !== 'observed') throw new Error(`unexpected result: ${unbornResult.kind}`)
    expect(unbornResult.observation.git.head).toBeUndefined()
    expect(unbornResult.observation.git.detached).toBe(false)

    const detached = await repository()
    await writeFile(join(detached, 'a'), 'a')
    await run(detached, ['add', 'a'])
    await run(detached, ['commit', '--quiet', '-m', 'a'])
    await run(detached, ['checkout', '--quiet', '--detach'])
    const detachedResult = await new GitObserver(detached, new MemoryGitObjectStore(), {
      repositoryId: 'repo_test',
    }).observe()
    if (detachedResult.kind !== 'observed')
      throw new Error(`unexpected result: ${detachedResult.kind}`)
    expect(detachedResult.observation.git.head).toMatch(/^[0-9a-f]{40}$/)
    expect(detachedResult.observation.git.branch).toBeUndefined()
    expect(detachedResult.observation.git.detached).toBe(true)
  })

  test('does not classify corrupt Git identity as an expected unborn state', async () => {
    const root = await repository()
    await writeFile(join(root, '.git', 'HEAD'), 'not a ref or object\n')
    const result = await new GitObserver(root, new MemoryGitObjectStore(), {
      repositoryId: 'repo_test',
    }).observe()
    expect(result).toMatchObject({ kind: 'unavailable', reason: { code: 'git-command-failed' } })
  })

  test('records LFS pointers, submodule pointers, and size exclusions without fetching', async () => {
    const child = await repository()
    await writeFile(join(child, 'child.txt'), 'child\n')
    await run(child, ['add', 'child.txt'])
    await run(child, ['commit', '--quiet', '-m', 'child'])
    const root = await repository()
    await writeFile(join(root, 'large.bin'), new Uint8Array(256))
    await writeFile(
      join(root, 'asset.dat'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 3\n`,
    )
    await writeFile(
      join(root, 'fake.dat'),
      'version https://git-lfs.github.com/spec/v1\noid sha256:not-valid\nsize 3\n',
    )
    await writeFile(
      join(root, 'high-bit.dat'),
      Buffer.from(
        Buffer.from(
          `version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize 3\n`,
        ).map(byte => byte | 0x80),
      ),
    )
    await run(root, ['add', 'large.bin', 'asset.dat', 'fake.dat', 'high-bit.dat'])
    await run(root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      child,
      'vendor/child',
    ])
    await run(root, ['commit', '--quiet', '-m', 'special entries'])
    await writeFile(join(root, 'large.bin'), new Uint8Array(256).fill(1))

    const objects = new MemoryGitObjectStore()
    const result = await new GitObserver(root, objects, {
      repositoryId: 'repo_test',
      maxFileBytes: 160,
    }).observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    expect(manifest.entries.find(entry => entry.path.display === 'asset.dat')?.kind).toBe(
      'lfs-pointer',
    )
    expect(manifest.entries.find(entry => entry.path.display === 'fake.dat')?.kind).toBe('file')
    expect(manifest.entries.find(entry => entry.path.display === 'high-bit.dat')?.kind).toBe('file')
    expect(manifest.entries.find(entry => entry.path.display === 'vendor/child')).toMatchObject({
      kind: 'gitlink',
      mode: '160000',
    })
    expect(manifest.entries.some(entry => entry.path.display === 'large.bin')).toBe(false)
    // Excluded content is unknown, not a verified change or proof of equality.
    expect(result.observation.changedPaths).toEqual([])
    expect(result.observation.limitations).toContainEqual(
      expect.objectContaining({
        code: 'excluded-by-limit',
        detail: expect.stringContaining('file exceeds 160'),
      }),
    )
    expect(manifest.limitations.map(item => item.code)).toEqual(
      expect.arrayContaining(['excluded-by-limit', 'unavailable-git-state']),
    )
  })

  test('works after checkout relocation and through a linked worktree', async () => {
    const original = await repository()
    await writeFile(join(original, 'a'), 'a')
    await run(original, ['add', 'a'])
    await run(original, ['commit', '--quiet', '-m', 'a'])
    const moved = `${original}-moved`
    await rename(original, moved)
    roots.splice(roots.indexOf(original), 1, moved)
    const movedResult = await new GitObserver(moved, new MemoryGitObjectStore(), {
      repositoryId: 'repo_test',
    }).observe()
    expect(movedResult.kind).toBe('observed')

    const linked = `${moved}-linked`
    await run(moved, ['worktree', 'add', '--quiet', '-b', 'linked', linked])
    roots.push(linked)
    const linkedResult = await new GitObserver(linked, new MemoryGitObjectStore(), {
      repositoryId: 'repo_test',
    }).observe()
    expect(linkedResult.kind).toBe('observed')
  })

  test('does not execute configured filters, external diff, hooks, or fsmonitor commands', async () => {
    const root = await repository()
    const marker = join(root, 'executed')
    await writeFile(join(root, '.gitattributes'), '*.txt filter=hostile diff=hostile\n')
    await writeFile(join(root, 'safe.txt'), 'safe\n')
    await run(root, ['add', '.gitattributes', 'safe.txt'])
    await run(root, ['commit', '--quiet', '-m', 'hostile config fixture'])
    await run(root, ['config', 'filter.hostile.clean', `touch ${marker}`])
    await run(root, ['config', 'filter.hostile.smudge', `touch ${marker}`])
    await run(root, ['config', 'diff.hostile.command', `touch ${marker}`])
    await run(root, ['config', 'core.fsmonitor', `touch ${marker}`])
    const hooks = join(root, 'hostile-hooks')
    await mkdir(hooks)
    await writeFile(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch ${marker}\n`)
    await chmod(join(hooks, 'post-index-change'), 0o755)
    await run(root, ['config', 'core.hooksPath', hooks])
    await writeFile(join(root, 'safe.txt'), 'evil\n')

    const result = await new GitObserver(root, new MemoryGitObjectStore(), {
      repositoryId: 'repo_test',
    }).observe()
    expect(result.kind).toBe('observed')
    if (result.kind !== 'observed') throw new Error('expected exact observation')
    expect(result.observation.changedPaths.map(path => path.display)).toContain('safe.txt')
    await expect(lstat(marker)).rejects.toThrow()
  })

  test('bounds and reaps commands that exceed their deadline', async () => {
    const root = await repository()
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'git'), '#!/bin/sh\nexec sleep 5\n')
    await chmod(join(bin, 'git'), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}:${previousPath ?? ''}`
    try {
      const result = await new GitObserver(root, new MemoryGitObjectStore(), {
        repositoryId: 'repo_test',
        maxGitDurationMs: 25,
      }).observe()
      expect(result).toEqual(
        expect.objectContaining({
          kind: 'unavailable',
          reason: expect.objectContaining({ code: 'git-command-timeout' }),
        }),
      )
    } finally {
      process.env.PATH = previousPath
    }
  })

  test('bounds stderr as well as stdout', async () => {
    const root = await repository()
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'git'), '#!/bin/sh\nyes error >&2\n')
    await chmod(join(bin, 'git'), 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}:${previousPath ?? ''}`
    try {
      const result = await new GitObserver(root, new MemoryGitObjectStore(), {
        repositoryId: 'repo_test',
        maxGitOutputBytes: 64,
      }).observe()
      expect(result).toEqual(
        expect.objectContaining({
          kind: 'unavailable',
          reason: expect.objectContaining({ code: 'git-output-limit' }),
        }),
      )
    } finally {
      process.env.PATH = previousPath
    }
  })

  test('labels a stable sparse omission instead of reading outside the sparse checkout', async () => {
    const root = await repository()
    await mkdir(join(root, 'kept'))
    await mkdir(join(root, 'omitted'))
    await writeFile(join(root, 'kept', 'a'), 'a')
    await writeFile(join(root, 'omitted', 'b'), 'b')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'sparse fixture'])
    await run(root, ['sparse-checkout', 'init', '--cone'])
    await run(root, ['sparse-checkout', 'set', 'kept'])

    const objects = new MemoryGitObjectStore()
    const result = await new GitObserver(root, objects, { repositoryId: 'repo_test' }).observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    expect(manifest.entries.some(entry => entry.path.display === 'omitted/b')).toBe(false)
    expect(result.observation.changedPaths.map(path => path.display)).not.toContain('omitted/b')
    expect(manifest.limitations).toContainEqual(
      expect.objectContaining({ detail: expect.stringContaining('sparse tracked path absent') }),
    )
  })

  test('treats tracked deletion as exact absence and excludes the entire .factory namespace', async () => {
    const root = await repository()
    await writeFile(join(root, 'deleted.txt'), 'gone\n')
    await mkdir(join(root, '.factory', 'skills'), { recursive: true })
    await writeFile(join(root, '.factory', 'manifest.json'), '{}\n')
    await writeFile(join(root, '.factory', 'skills', 'review.md'), 'foreign but not code\n')
    await run(root, ['add', '-A'])
    await run(root, ['commit', '--quiet', '-m', 'factory namespace fixture'])
    await rm(join(root, 'deleted.txt'))
    await writeFile(join(root, '.factory', 'manifest.json'), '{"changed":true}\n')
    await run(root, ['add', '.factory/manifest.json'])

    const objects = new MemoryGitObjectStore()
    const result = await new GitObserver(root, objects, { repositoryId: 'repo_test' }).observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    expect(manifest.entries).toEqual([])
    expect(result.observation.changedPaths.map(path => path.display)).toEqual(['deleted.txt'])
    expect(result.observation.stagedPatch).toBeUndefined()
    expect(manifest.limitations.some(item => item.detail.includes('deleted'))).toBe(false)
  })

  test('captures the readable worktree file when the index is conflicted', async () => {
    const root = await repository()
    await writeFile(join(root, 'conflict.txt'), 'base\n')
    await run(root, ['add', 'conflict.txt'])
    await run(root, ['commit', '--quiet', '-m', 'base'])
    await run(root, ['checkout', '--quiet', '-b', 'other'])
    await writeFile(join(root, 'conflict.txt'), 'other\n')
    await run(root, ['commit', '--quiet', '-am', 'other'])
    await run(root, ['checkout', '--quiet', 'master'])
    await writeFile(join(root, 'conflict.txt'), 'main\n')
    await run(root, ['commit', '--quiet', '-am', 'main'])
    await runExpectingFailure(root, ['merge', '--no-edit', 'other'])

    const objects = new MemoryGitObjectStore()
    const result = await new GitObserver(root, objects, { repositoryId: 'repo_test' }).observe()
    if (result.kind !== 'observed') throw new Error(`unexpected result: ${result.kind}`)
    const manifest = await objects.readJson(result.observation.codeManifest!)
    expect(manifest.entries.map(entry => entry.path.display)).toEqual(['conflict.txt'])
    expect(manifest.limitations).toContainEqual(
      expect.objectContaining({ detail: expect.stringContaining('unmerged index state') }),
    )
  })
})
