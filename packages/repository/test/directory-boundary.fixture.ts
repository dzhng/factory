import * as ffi from 'bun:ffi'
import { mock } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'

if (process.env.FACTORY_DOCKER_TEST !== '1') throw new Error('Docker fixture required')
const actualDlopen = ffi.dlopen
const native = actualDlopen('libc.so.6', {
  close: { args: ['i32'], returns: 'i32' },
  dirfd: { args: ['ptr'], returns: 'i32' },
})
const failRead = process.argv.includes('--fail-read')
mock.module('bun:ffi', () => ({
  ...ffi,
  dlopen: (path: string, symbols: Parameters<typeof ffi.dlopen>[1]) => {
    const loaded = actualDlopen(path, symbols)
    for (const name of ['readdir', 'getdirentries64']) {
      const read = Reflect.get(loaded.symbols, name)
      if (typeof read !== 'function') continue
      Reflect.set(loaded.symbols, name, (...args: number[]) => {
        if (failRead)
          native.symbols.close(
            name === 'readdir' ? native.symbols.dirfd(args[0]! as ffi.Pointer) : args[0]!,
          )
        const result = Reflect.apply(read, undefined, args)
        if (
          name === 'getdirentries64' &&
          process.argv.includes('--zero-inode') &&
          Number(result) > 0
        ) {
          const batch = Buffer.from(ffi.toArrayBuffer(args[1]! as ffi.Pointer, 0, Number(result)))
          for (let offset = 0; offset < batch.byteLength; offset += batch.readUInt16LE(offset + 16))
            batch.writeBigUInt64LE(0n, offset)
        }
        // The native call has returned. Unrelated runtime work can change
        // thread-local errno before JavaScript receives the translated result.
        if (!failRead) native.symbols.close(-1)
        return result
      })
    }
    return loaded
  },
}))
const { inventoryConfinedTree } = await import('../src/confined-writer')
const root = await mkdtemp('/tmp/factory-directory-boundary-')
await mkdir(`${root}/nested`)
await writeFile(`${root}/nested/file`, 'bytes')
try {
  const entries = await inventoryConfinedTree(root, {
    maximumEntries: 2,
    maximumFileBytes: 5,
    maximumBytes: 5,
  })
  if (failRead) throw new Error('native directory read error was accepted as EOF')
  process.stdout.write(JSON.stringify(entries))
} catch (error) {
  if (!failRead || !String(error).includes('cannot read confined reconstruction directory'))
    throw error
  process.stdout.write(JSON.stringify({ refused: true }))
}
