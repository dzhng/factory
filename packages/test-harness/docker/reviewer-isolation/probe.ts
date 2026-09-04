import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const scenario = process.argv[2] ?? 'success'
const provider = process.argv[3] ?? 'fake'
const authPath =
  provider === 'codex'
    ? '/auth/codex/auth.json'
    : provider === 'claude'
      ? '/auth/claude/.credentials.json'
      : '/auth/fake/credentials.json'
let providerVersion = 'fake-provider/1'

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
  await writeFile('/review-input/bundle.json', manifestBytes)
  for (const file of bundle.files) {
    const bytes = await readFile(`/bundle/${file.path}`)
    if (
      bytes.byteLength !== file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new Error('bundle file differs inside reviewer container')
    const snapshotPath = `/review-input/${file.path}`
    await mkdir(dirname(snapshotPath), { recursive: true })
    await writeFile(snapshotPath, bytes)
  }
  if (!process.argv[4] || !process.argv[5] || !process.argv[6])
    throw new Error('reviewer model, effort, and prompt version are required')
  const invocation = JSON.parse(Buffer.from(process.argv[8] ?? '', 'base64').toString()) as {
    executable: string
    argv: string[]
    cwd: string
    environment: Record<string, string>
    prompt: string
    response: { kind: 'file'; path: string } | { kind: 'stdout' }
    versionArgv: string[]
  }
  if (
    invocation.executable !== provider ||
    invocation.cwd !== '/review-input' ||
    invocation.prompt.length === 0 ||
    (invocation.response.kind === 'file' && invocation.response.path !== '/out/response.txt')
  )
    throw new Error('review adapter invocation is outside the container runner contract')
  const versionProcess = Bun.spawn([invocation.executable, ...invocation.versionArgv], {
    cwd: invocation.cwd,
    env: invocation.environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [versionExit, versionStdout] = await Promise.all([
    versionProcess.exited,
    new Response(versionProcess.stdout).text(),
  ])
  if (versionExit !== 0) throw new Error('review provider version command failed')
  providerVersion = versionStdout.trim()
  const reviewProcess = Bun.spawn([invocation.executable, ...invocation.argv], {
    cwd: invocation.cwd,
    env: invocation.environment,
    stdin: new Blob([invocation.prompt]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [reviewExit, reviewStdout, reviewStderr] = await Promise.all([
    reviewProcess.exited,
    new Response(reviewProcess.stdout).arrayBuffer(),
    new Response(reviewProcess.stderr).arrayBuffer(),
  ])
  if (reviewStdout.byteLength + reviewStderr.byteLength > 1024 * 1024)
    throw new Error('review provider command output exceeded its bound')
  if (reviewExit !== 0) throw new Error('review provider command failed')
  if (invocation.response.kind === 'stdout')
    await writeFile('/out/response.txt', new Uint8Array(reviewStdout))
} else {
  await writeFile('/out/result.txt', 'fake-review-complete\n')
}
const routeTable = await readFile('/proc/net/route', 'utf8').catch(() => '')

console.log(
  JSON.stringify({
    providerVersion,
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
