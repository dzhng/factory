import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfinedWriter, inventoryConfinedTree, readConfinedFile } from '../src/confined-writer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ConfinedWriter', () => {
  test('reads only selected files through ignored nested directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-discovery-'))
    roots.push(root)
    await mkdir(join(root, 'ignored'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, '.gitignore'), 'ignored/\n')
    await writeFile(join(root, '.env'), 'ROOT=synthetic-root\n')
    await writeFile(join(root, 'ignored', '.env.local'), 'NESTED=synthetic-nested\n')
    await writeFile(join(root, 'node_modules', '.env'), 'EXCLUDED=synthetic-excluded\n')
    await writeFile(join(root, 'ordinary'), 'unselected'.repeat(1024))

    const bytes = await ConfinedWriter.readFiles(root, {
      maximumEntries: 6,
      maximumDepth: 2,
      maximumFiles: 2,
      maximumFileBytes: 32,
      maximumBytes: 64,
      includeFile: name => name.startsWith('.env'),
      skipDirectory: name => name === 'node_modules',
    })
    expect(bytes.map(value => Buffer.from(value).toString())).toEqual([
      'ROOT=synthetic-root\n',
      'NESTED=synthetic-nested\n',
    ])
  })

  test('discovers ASCII-selected files while preserving non-UTF-8 path bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-discovery-'))
    roots.push(root)
    const prefix = Buffer.from(`${root}/`)
    const nested = Buffer.concat([prefix, Buffer.from([0xff])])
    await mkdir(nested)
    await writeFile(
      Buffer.concat([prefix, Buffer.from('.env.'), Buffer.from([0xff])]),
      'ROOT=retained\n',
    )
    await writeFile(Buffer.concat([nested, Buffer.from('/.env')]), 'NESTED=retained\n')
    await writeFile(Buffer.concat([prefix, Buffer.from([0xfe])]), 'UNRELATED=excluded\n')
    const bytes = await ConfinedWriter.readFiles(root, {
      maximumEntries: 4,
      maximumDepth: 2,
      maximumFiles: 2,
      maximumFileBytes: 100,
      maximumBytes: 200,
      includeFile: name => name.startsWith('.env'),
      skipDirectory: () => false,
    })
    expect(bytes.map(value => Buffer.from(value).toString())).toEqual([
      'ROOT=retained\n',
      'NESTED=retained\n',
    ])
  })

  test('excludes nested repositories and both file and directory symlinks', async () => {
    const base = await mkdtemp(join(tmpdir(), 'factory-confined-discovery-'))
    roots.push(base)
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await mkdir(join(root, '.git'))
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', '.git'), 'gitdir: synthetic\n')
    await writeFile(join(root, 'nested', '.env'), 'NESTED=excluded\n')
    await writeFile(join(root, '.env'), 'ROOT=retained\n')
    await writeFile(join(outside, '.env'), 'OUTSIDE=excluded\n')
    await symlink(outside, join(root, 'directory-link'))
    await symlink(join(outside, '.env'), join(root, '.env.link'))
    await symlink(join(outside, 'missing'), join(root, '.env.dangling'))

    const bytes = await ConfinedWriter.readFiles(root, {
      maximumEntries: 6,
      maximumDepth: 3,
      maximumFiles: 3,
      maximumFileBytes: 100,
      maximumBytes: 300,
      includeFile: name => name.startsWith('.env'),
      skipDirectory: name => name === '.git',
      skipNestedRepositories: true,
    })
    expect(bytes.map(value => Buffer.from(value).toString())).toEqual(['ROOT=retained\n'])
  })

  test('ignores unrelated special files and refuses a matched FIFO without blocking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-discovery-'))
    roots.push(root)
    execFileSync('mkfifo', [join(root, 'unrelated-pipe')])
    const bounds = {
      maximumEntries: 2,
      maximumDepth: 1,
      maximumFiles: 1,
      maximumFileBytes: 10,
      maximumBytes: 10,
      includeFile: (name: string) => name.startsWith('.env'),
      skipDirectory: () => false,
    }
    expect(await ConfinedWriter.readFiles(root, bounds)).toEqual([])
    execFileSync('mkfifo', [join(root, '.env.pipe')])
    await expect(ConfinedWriter.readFiles(root, bounds)).rejects.toThrow(
      'confined file discovery failed',
    )
  })

  test.each(['file-replaced', 'file-mutated', 'directory-replaced', 'sibling-added'])(
    'refuses a racing discovery without returning a partial dictionary: %s',
    async race => {
      const base = await mkdtemp(join(tmpdir(), 'factory-confined-discovery-'))
      roots.push(base)
      const root = join(base, 'root')
      const outside = join(base, 'outside')
      await mkdir(join(root, 'nested'), { recursive: true })
      await mkdir(outside)
      await writeFile(join(root, 'nested', '.env'), 'VALUE=before\n')
      await utimes(join(root, 'nested', '.env'), 1, 1)
      await writeFile(join(outside, '.env'), 'VALUE=outside\n')
      let changed = false
      await expect(
        ConfinedWriter.readFiles(root, {
          maximumEntries: 10,
          maximumDepth: 3,
          maximumFiles: 3,
          maximumFileBytes: 100,
          maximumBytes: 300,
          includeFile: name => name.startsWith('.env'),
          skipDirectory: () => false,
          afterEntryOpen: async path => {
            if (changed || path.length !== (race === 'directory-replaced' ? 1 : 2)) return
            changed = true
            if (race === 'directory-replaced') {
              await rename(join(root, 'nested'), join(root, 'old-nested'))
              await symlink(outside, join(root, 'nested'))
            } else if (race === 'file-replaced') {
              await unlink(join(root, 'nested', '.env'))
              await symlink(join(outside, '.env'), join(root, 'nested', '.env'))
            } else if (race === 'file-mutated') {
              await writeFile(join(root, 'nested', '.env'), 'VALUE=after!\n')
              await utimes(join(root, 'nested', '.env'), 2, 2)
            } else {
              await writeFile(join(root, '.env.new'), 'VALUE=inserted\n')
            }
          },
        }),
      ).rejects.toThrow('confined file discovery failed')
      expect(changed).toBe(true)
    },
  )

  test.each([
    ['maximumEntries', 4],
    ['maximumDepth', 1],
    ['maximumFiles', 1],
    ['maximumFileBytes', 3],
    ['maximumBytes', 7],
  ] as const)('enforces discovery %s including excluded entry traversal', async (limit, value) => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-discovery-'))
    roots.push(root)
    await mkdir(join(root, 'nested'))
    await mkdir(join(root, 'excluded'))
    await writeFile(join(root, '.env'), '1234')
    await writeFile(join(root, 'nested', '.env'), '5678')
    await writeFile(join(root, 'ordinary'), 'unselected'.repeat(1024))
    const bounds = {
      maximumEntries: 5,
      maximumDepth: 2,
      maximumFiles: 2,
      maximumFileBytes: 4,
      maximumBytes: 8,
      includeFile: (name: string) => name.startsWith('.env'),
      skipDirectory: (name: string) => name === 'excluded',
    }
    expect(
      (await ConfinedWriter.readFiles(root, bounds)).map(bytes => Buffer.from(bytes).toString()),
    ).toEqual(['1234', '5678'])
    await expect(ConfinedWriter.readFiles(root, { ...bounds, [limit]: value })).rejects.toThrow(
      'confined file discovery failed',
    )
  })

  test.each(['file', 'directory'])(
    'rechecks earlier %s state after later discovery entries',
    async kind => {
      const root = await mkdtemp(join(tmpdir(), 'factory-confined-discovery-'))
      roots.push(root)
      await mkdir(join(root, 'a'))
      await mkdir(join(root, 'z'))
      await writeFile(join(root, 'a', '.env'), 'VALUE=first\n')
      await writeFile(join(root, 'z', '.env'), 'VALUE=last\n')
      await expect(
        ConfinedWriter.readFiles(root, {
          maximumEntries: 10,
          maximumDepth: 2,
          maximumFiles: 3,
          maximumFileBytes: 100,
          maximumBytes: 300,
          includeFile: name => name.startsWith('.env'),
          skipDirectory: () => false,
          afterEntryOpen: async path => {
            if (path.length !== 2 || Buffer.from(path[0]!).toString() !== 'z') return
            await writeFile(
              join(root, 'a', kind === 'file' ? '.env' : '.env.new'),
              'VALUE=changed\n',
            )
          },
        }),
      ).rejects.toThrow('confined file discovery failed')
    },
  )

  test('requires readable matched files and traversed directories without reading other files', async () => {
    if (process.env.FACTORY_DOCKER_TEST !== '1')
      throw new Error('requires the Docker test environment')
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-discovery-'))
    roots.push(root)
    await chmod(root, 0o755)
    await writeFile(join(root, '.env'), 'VALUE=retained\n')
    await writeFile(join(root, 'unrelated'), 'VALUE=unreadable\n', { mode: 0 })
    const read = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            '-e',
            `
      import { ConfinedWriter } from ${JSON.stringify(join(import.meta.dir, '../src/confined-writer.ts'))};
      process.setgid(65534);
      process.setuid(65534);
      try {
        const files = await ConfinedWriter.readFiles(${JSON.stringify(root)}, {
          maximumEntries: 10, maximumDepth: 3, maximumFiles: 3,
          maximumFileBytes: 100, maximumBytes: 300,
          includeFile: name => name.startsWith('.env'), skipDirectory: () => false,
        });
        console.log(JSON.stringify({ files: files.map(value => Buffer.from(value).toString()) }));
      } catch (error) { console.log(JSON.stringify({ error: error.message })); }
    `,
          ],
          { encoding: 'utf8' },
        ),
      )
    expect(read()).toEqual({ files: ['VALUE=retained\n'] })
    await chmod(join(root, '.env'), 0)
    expect(read()).toEqual({ error: 'confined file discovery failed' })
    await chmod(join(root, '.env'), 0o644)
    await mkdir(join(root, 'unreadable'), { mode: 0 })
    expect(read()).toEqual({ error: 'confined file discovery failed' })
  })

  test('detects late byte changes even when filesystem timestamps and sizes remain equal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-discovery-'))
    roots.push(root)
    await writeFile(join(root, '.env.a'), Buffer.alloc(100_001, 0x61))
    await writeFile(join(root, '.env.z'), 'end')
    const result = execFileSync(
      process.execPath,
      [
        '-e',
        `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs';
      import { open } from 'node:fs/promises';
      const originalStat = fs.fstatSync;
      // Model a coarse filesystem clock; all file operations and identities stay real.
      mock.module('node:fs', () => ({ ...fs, fstatSync: (...args) => {
        const state = originalStat(...args);
        state.mtimeNs = 0n;
        state.ctimeNs = 0n;
        return state;
      }}));
      const { ConfinedWriter } = await import(${JSON.stringify(join(import.meta.dir, '../src/confined-writer.ts'))});
      try {
        await ConfinedWriter.readFiles(${JSON.stringify(root)}, {
          maximumEntries: 2, maximumDepth: 1, maximumFiles: 2,
          maximumFileBytes: 200000, maximumBytes: 200000,
          includeFile: name => name.startsWith('.env'), skipDirectory: () => false,
          afterEntryOpen: async path => {
            if (Buffer.from(path[0]).toString() === '.env.z') {
              const file = await open(${JSON.stringify(join(root, '.env.a'))}, 'r+');
              try { await file.write(Buffer.from('b'), 0, 1, 100000); }
              finally { await file.close(); }
            }
          },
        });
        console.log(JSON.stringify({ accepted: true }));
      } catch (error) { console.log(JSON.stringify({ error: error.message })); }
    `,
      ],
      { encoding: 'utf8', timeout: 5000 },
    )
    const changed = Buffer.alloc(100_001, 0x61)
    changed[100_000] = 0x62
    expect(await readFile(join(root, '.env.a'))).toEqual(changed)
    expect(JSON.parse(result)).toEqual({ error: 'confined file discovery failed' })
  })

  test.each(['callback-directory', 'nested-repository', 'unselected-file'])(
    'ignores content churn outside discovery policy: %s',
    async kind => {
      const root = await mkdtemp(join(tmpdir(), 'factory-confined-discovery-'))
      roots.push(root)
      if (kind === 'unselected-file') await writeFile(join(root, 'excluded'), 'unselected')
      else await mkdir(join(root, 'excluded'))
      if (kind === 'nested-repository')
        await writeFile(join(root, 'excluded', '.git'), 'gitdir: synthetic')
      await utimes(join(root, 'excluded'), 1, 1)
      await writeFile(join(root, '.env'), 'VALUE=retained\n')
      const files = await ConfinedWriter.readFiles(root, {
        maximumEntries: 2,
        maximumDepth: 1,
        maximumFiles: 1,
        maximumFileBytes: 100,
        maximumBytes: 100,
        includeFile: name => name.startsWith('.env'),
        skipDirectory: name => kind === 'callback-directory' && name === 'excluded',
        skipNestedRepositories: kind === 'nested-repository',
        afterEntryOpen: async path => {
          if (Buffer.from(path[0]!).toString() !== 'excluded') return
          await writeFile(
            kind === 'unselected-file' ? join(root, 'excluded') : join(root, 'excluded', '.env'),
            'VALUE=excluded\n',
          )
          await utimes(join(root, 'excluded'), 2, 2)
        },
      })
      expect(files.map(bytes => Buffer.from(bytes).toString())).toEqual(['VALUE=retained\n'])
    },
  )

  test.each(['normal', 'zero-inode'])(
    'does not confuse runtime errno changes with a native directory read failure %s',
    async mode => {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'directory-boundary.fixture.ts'),
          ...(mode === 'zero-inode' ? ['--zero-inode'] : []),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stderr).toBe('')
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toEqual([
        { kind: 'directory', path: 'nested' },
        { kind: 'file', path: 'nested/file' },
      ])
    },
  )
  test('refuses a real native directory read error instead of treating it as EOF', async () => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'directory-boundary.fixture.ts'), '--fail-read'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ refused: true })
  })
  test('inventories an ordinary tree and enforces every bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-inventory-'))
    roots.push(root)
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'file'), 'bytes')
    const bounds = { maximumEntries: 2, maximumFileBytes: 5, maximumBytes: 5, maximumDepth: 2 }
    expect(await inventoryConfinedTree(root, bounds)).toEqual([
      { kind: 'directory', path: 'nested' },
      { kind: 'file', path: 'nested/file' },
    ])
    await expect(inventoryConfinedTree(root, { ...bounds, maximumEntries: 1 })).rejects.toThrow(
      'inventory',
    )
    await expect(inventoryConfinedTree(root, { ...bounds, maximumFileBytes: 4 })).rejects.toThrow(
      'byte limits',
    )
    await expect(inventoryConfinedTree(root, { ...bounds, maximumBytes: 4 })).rejects.toThrow(
      'byte limits',
    )
    await expect(inventoryConfinedTree(root, { ...bounds, maximumDepth: 1 })).rejects.toThrow(
      'depth',
    )
  })

  test('inventories long names across native directory batches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-directory-batches-'))
    roots.push(root)
    const names = Array.from(
      { length: 260 },
      (_, index) => `${String(index).padStart(3, '0')}-${'x'.repeat(251)}`,
    )
    for (const name of names) await writeFile(join(root, name), '')
    const result = await inventoryConfinedTree(root, {
      maximumEntries: names.length,
      maximumFileBytes: 0,
      maximumBytes: 0,
    })
    expect(result.map(entry => entry.path).sort()).toEqual(names)
  })

  test('filters root namespaces before charging inventory bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-roots-'))
    roots.push(root)
    await mkdir(join(root, 'review-triggers'))
    await writeFile(join(root, 'review-triggers', 'one.json'), '{}\n')
    for (let index = 0; index < 20; index += 1) {
      const foreign = join(root, `foreign-${index}`)
      await mkdir(foreign)
      await writeFile(join(foreign, 'large'), 'x'.repeat(1024))
    }
    expect(
      await inventoryConfinedTree(root, {
        maximumEntries: 2,
        maximumFileBytes: 3,
        maximumBytes: 3,
        maximumDepth: 2,
        rootNames: ['review-triggers'],
      }),
    ).toEqual([
      { kind: 'directory', path: 'review-triggers' },
      { kind: 'file', path: 'review-triggers/one.json' },
    ])
  })

  test('confined inventory rejects symlinks and directory swaps', async () => {
    const base = await mkdtemp(join(tmpdir(), 'factory-confined-inventory-'))
    roots.push(base)
    const root = join(base, 'root')
    const replacement = join(base, 'replacement')
    await mkdir(root)
    await mkdir(replacement)
    await writeFile(join(replacement, 'secret'), 'outside')
    await symlink(replacement, join(root, 'link'))
    await expect(
      inventoryConfinedTree(root, {
        maximumEntries: 4,
        maximumFileBytes: 1024,
        maximumBytes: 1024,
      }),
    ).rejects.toThrow('symbolic links')
    await unlink(join(root, 'link'))
    await mkdir(join(root, 'nested'))
    let swapped = false
    await expect(
      inventoryConfinedTree(root, {
        maximumEntries: 4,
        maximumFileBytes: 1024,
        maximumBytes: 1024,
        afterEntryOpen: async path => {
          if (swapped || Buffer.from(path[0]!).toString() !== 'nested') return
          swapped = true
          await rename(join(root, 'nested'), join(root, 'old-nested'))
          await symlink(replacement, join(root, 'nested'))
        },
      }),
    ).rejects.toThrow('changed during inventory')
  })

  test('confined reads cannot follow a swapped parent outside their root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'factory-confined-reader-'))
    roots.push(base)
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    await mkdir(join(root, 'nested'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(root, 'nested', 'transcript.jsonl'), 'inside\n')
    await writeFile(join(outside, 'transcript.jsonl'), 'outside-secret\n')

    const bytes = await readConfinedFile(
      root,
      [Buffer.from('nested'), Buffer.from('transcript.jsonl')],
      {
        maximumBytes: 1024,
        afterOpen: async () => {
          await rename(join(root, 'nested'), join(root, 'old-nested'))
          await symlink(outside, join(root, 'nested'))
        },
      },
    )
    expect(new TextDecoder().decode(bytes)).toBe('inside\n')
  })

  test('rejects an invalid symlink target before opening or creating parent directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-writer-'))
    roots.push(root)
    const writer = await ConfinedWriter.open(root, await lstat(root, { bigint: true }))

    try {
      await expect(
        writer.symlink([Buffer.from('nested'), Buffer.from('link')], Buffer.from([0])),
      ).rejects.toThrow('confined path contains NUL')
      expect(await readdir(root)).toEqual([])
    } finally {
      await writer.close()
    }
  })

  test('rejects traversal at the descriptor boundary without writing outside', async () => {
    const base = await mkdtemp(join(tmpdir(), 'factory-confined-writer-'))
    roots.push(base)
    const root = join(base, 'root')
    await mkdir(root)
    const writer = await ConfinedWriter.open(root, await lstat(root, { bigint: true }))

    try {
      await expect(
        writer.writeFile([Buffer.from('..'), Buffer.from('escaped')], Buffer.from('no'), 0o644),
      ).rejects.toThrow('confined path contains an unsafe segment')
      await expect(readFile(join(base, 'escaped'))).rejects.toThrow()
    } finally {
      await writer.close()
    }
  })

  test('owns file bytes before descriptor setup yields to a mutable caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-writer-'))
    roots.push(root)
    const writer = await ConfinedWriter.open(root, await lstat(root, { bigint: true }))
    const shared = Buffer.from('original\n')

    try {
      const writing = writer.writeFile(
        [Buffer.from('nested'), Buffer.from('source.txt')],
        shared,
        0o644,
      )
      shared.set(Buffer.from('mutated!\n'))
      await writing
      expect(await readFile(join(root, 'nested', 'source.txt'), 'utf8')).toBe('original\n')
    } finally {
      await writer.close()
    }
  })

  test('rejects a pathname replaced after its inventory descriptor opens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-writer-'))
    roots.push(root)
    const path = join(root, 'source.txt')
    let replaced = false
    const writer = await ConfinedWriter.open(root, await lstat(root, { bigint: true }), {
      afterInventoryOpen: async () => {
        if (replaced) return
        replaced = true
        await unlink(path)
        await writeFile(path, 'source\n', { mode: 0o644 })
      },
    })
    const bytes = Buffer.from('source\n')

    try {
      await writer.writeFile([Buffer.from('source.txt')], bytes, 0o644)
      await expect(
        writer.assertExact([
          {
            path: [Buffer.from('source.txt')],
            kind: 'file',
            mode: 0o644,
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ]),
      ).rejects.toThrow('inventory')
    } finally {
      await writer.close()
    }
  })

  test('rejects a sibling injected after the directory inventory starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-writer-'))
    roots.push(root)
    let injected = false
    const writer = await ConfinedWriter.open(root, await lstat(root, { bigint: true }), {
      afterInventoryOpen: async () => {
        if (injected) return
        injected = true
        await writeFile(join(root, 'extra.txt'), 'extra\n')
      },
    })
    const bytes = Buffer.from('source\n')

    try {
      await writer.writeFile([Buffer.from('source.txt')], bytes, 0o644)
      await expect(
        writer.assertExact([
          {
            path: [Buffer.from('source.txt')],
            kind: 'file',
            mode: 0o644,
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ]),
      ).rejects.toThrow('inventory')
    } finally {
      await writer.close()
    }
  })

  test('rejects a same-size write to an already-hashed file region', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-confined-writer-'))
    roots.push(root)
    const path = join(root, 'source.bin')
    let changed = false
    const writer = await ConfinedWriter.open(root, await lstat(root, { bigint: true }), {
      afterInventoryChunk: async () => {
        if (changed) return
        changed = true
        const file = await open(path, 'r+')
        try {
          await file.write(Buffer.from([0x42]), 0, 1, 0)
        } finally {
          await file.close()
        }
      },
    })
    const bytes = Buffer.alloc(128 * 1024, 0x41)

    try {
      await writer.writeFile([Buffer.from('source.bin')], bytes, 0o644)
      await expect(
        writer.assertExact([
          {
            path: [Buffer.from('source.bin')],
            kind: 'file',
            mode: 0o644,
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ]),
      ).rejects.toThrow('changed during inventory')
    } finally {
      await writer.close()
    }
  })
})
