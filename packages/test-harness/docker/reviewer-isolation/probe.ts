import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const scenario = process.argv[2] ?? 'success'
const provider = process.argv[3] ?? 'fake'
const authPath = `/auth/${provider}/credentials.json`

if (scenario === 'hang') {
  await new Promise(() => undefined)
}

if (scenario === 'descendant') {
  spawn('sh', ['-c', 'while true; do sleep 1; done'], {
    detached: false,
    stdio: 'ignore',
  })
  await new Promise(() => undefined)
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function writeIsBlocked(path: string): Promise<boolean> {
  try {
    await appendFile(path, 'forbidden')
    return false
  } catch {
    return true
  }
}

const otherProviderAuth =
  provider === 'fake'
    ? ['/auth/codex', '/auth/claude']
    : [provider === 'codex' ? '/auth/claude' : '/auth/codex']
const forbiddenPaths = [
  '/bundle/.git',
  '/workspace/factory-live-checkout-sentinel',
  '/var/run/docker.sock',
  ...otherProviderAuth,
  '/root/.codex',
  '/root/.claude',
]
const forbiddenPathsAbsent: string[] = []
for (const path of forbiddenPaths) {
  if (!(await canRead(path))) forbiddenPathsAbsent.push(path)
}

await readFile(authPath)
if (scenario === 'review') {
  const manifestBytes = await readFile('/bundle/bundle.json')
  const actualDigest = createHash('sha256').update(manifestBytes).digest('hex')
  if (actualDigest !== process.argv[7])
    throw new Error('bundle digest differs inside reviewer container')
  const bundle = JSON.parse(manifestBytes.toString()) as {
    files: { path: string; sha256: string; bytes: number }[]
    inventory: unknown[]
  }
  const expectedEntries = new Map<string, 'file' | 'directory'>([['bundle.json', 'file']])
  for (const file of bundle.files) {
    if (file.path.startsWith('/') || file.path.split('/').includes('..'))
      throw new Error('bundle contains an unsafe portable path')
    expectedEntries.set(file.path, 'file')
    const segments = file.path.split('/')
    for (let index = 1; index < segments.length; index += 1)
      expectedEntries.set(segments.slice(0, index).join('/'), 'directory')
  }
  const actualEntries = new Map<string, 'file' | 'directory' | 'other'>()
  const inventory = async (root: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'
      actualEntries.set(relative, kind)
      if (kind === 'directory') await inventory(`${root}/${entry.name}`, relative)
    }
  }
  await inventory('/bundle')
  if (JSON.stringify([...actualEntries].sort()) !== JSON.stringify([...expectedEntries].sort()))
    throw new Error('bundle tree differs inside reviewer container')
  await mkdir('/tmp/verified-bundle')
  await writeFile('/tmp/verified-bundle/bundle.json', manifestBytes)
  for (const file of bundle.files) {
    const bytes = await readFile(`/bundle/${file.path}`)
    if (
      bytes.byteLength !== file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new Error('bundle file differs inside reviewer container')
    const snapshotPath = `/tmp/verified-bundle/${file.path}`
    await mkdir(dirname(snapshotPath), { recursive: true })
    await writeFile(snapshotPath, bytes)
  }
  if (!process.argv[4] || !process.argv[5] || !process.argv[6])
    throw new Error('reviewer model, effort, and prompt version are required')
  await writeFile(
    '/out/response.txt',
    `${JSON.stringify({ kind: 'summary', summary: 'Deterministic fake review completed', evidence: [{ object: bundle.inventory[0] }] })}\n`,
  )
} else {
  await writeFile('/out/result.txt', 'fake-review-complete\n')
}
const routeTable = await readFile('/proc/net/route', 'utf8').catch(() => '')

console.log(
  JSON.stringify({
    providerVersion: 'fake-provider/1',
    uid: process.getuid?.() ?? -1,
    bundleReadable: await canRead('/bundle/input.json'),
    bundleWriteBlocked: await writeIsBlocked('/bundle/input.json'),
    authReadable: await canRead(authPath),
    authWriteBlocked: await writeIsBlocked(authPath),
    outputWritable: await canRead(scenario === 'review' ? '/out/response.txt' : '/out/result.txt'),
    forbiddenPathsAbsent,
    networkRoutePresent: routeTable.includes('eth0'),
  }),
)
