import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function configRoot(environment: NodeJS.ProcessEnv): string {
  return join(
    environment.XDG_CONFIG_HOME ?? join(environment.HOME ?? homedir(), '.config'),
    'factory',
  )
}

export async function pathKind(
  path: string,
): Promise<'missing' | 'file' | 'directory' | 'symlink'> {
  try {
    const value = await lstat(path)
    if (value.isSymbolicLink()) return 'symlink'
    if (value.isFile()) return 'file'
    if (value.isDirectory()) return 'directory'
    throw new Error(`unsupported filesystem entry: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicWrite(path: string, bytes: Uint8Array, mode: 0o600 | 0o755): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if ((await pathKind(path)) === 'symlink')
    throw new Error(`Factory refuses symbolic link: ${path}`)
  const temporary = `${path}.factory-${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx', mode })
  const handle = await open(temporary, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}

export async function atomicPrivateWrite(path: string, bytes: Uint8Array): Promise<void> {
  await atomicWrite(path, bytes, 0o600)
}

export async function atomicExecutableWrite(path: string, bytes: Uint8Array): Promise<void> {
  await atomicWrite(path, bytes, 0o755)
}

export async function readBoundedOrdinaryFile(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array | undefined> {
  const kind = await pathKind(path)
  if (kind === 'missing') return undefined
  if (kind !== 'file') throw new Error(`Factory requires an ordinary file: ${path}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`Factory requires an ordinary file: ${path}`)
    if (info.size > maximumBytes) throw new Error(`Factory file exceeds its size bound: ${path}`)
    const bytes = new Uint8Array(info.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) throw new Error(`Factory file changed while reading: ${path}`)
      offset += bytesRead
    }
    const extra = new Uint8Array(1)
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0)
      throw new Error(`Factory file changed while reading: ${path}`)
    return bytes
  } finally {
    await handle.close()
  }
}
