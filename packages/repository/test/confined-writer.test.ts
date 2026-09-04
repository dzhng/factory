import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
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
