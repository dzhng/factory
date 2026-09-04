import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, access, readFile, writeFile } from 'node:fs/promises'

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
  for (const file of bundle.files) {
    const bytes = await readFile(`/bundle/${file.path}`)
    if (
      bytes.byteLength !== file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new Error('bundle file differs inside reviewer container')
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
