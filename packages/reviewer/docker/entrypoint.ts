import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, access, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'

// This image entrypoint verifies the mounted boundary before invoking either reviewer CLI.

const scenario = process.argv[2] ?? 'success'
const provider = process.argv[3] ?? 'fake'
const authPath =
  provider === 'codex'
    ? '/auth/codex/auth.json'
    : provider === 'claude'
      ? '/auth/claude/.credentials.json'
      : '/auth/fake/credentials.json'
let providerVersion = 'fake-provider/1'
const MAX_PROVIDER_OUTPUT_BYTES = 1024 * 1024
const MAX_PROVIDER_VERSION_BYTES = 64 * 1024

async function boundedFileSha256(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error('reviewer authentication is not a bounded ordinary file')
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (
      offset !== bytes.length ||
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== info.size
    )
      throw new Error('reviewer authentication changed while it was read')
    return createHash('sha256').update(bytes).digest('hex')
  } finally {
    await handle.close()
  }
}

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

async function drainBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onChunk?: (chunk: Uint8Array) => Promise<void>,
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let retained = 0
  let observed = 0
  let overflow = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value
      observed += chunk.byteLength
      const allowed = Math.max(0, limit + 1 - retained)
      if (allowed > 0) {
        const prefix = chunk.subarray(0, allowed)
        retained += prefix.byteLength
        if (onChunk === undefined) chunks.push(prefix)
        else await onChunk(prefix)
      }
      if (observed > limit) overflow = true
    }
  } finally {
    reader.releaseLock()
  }
  if (onChunk !== undefined) return { bytes: new Uint8Array(), overflow }
  const bytes = new Uint8Array(retained)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, overflow }
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
  const manifestBytes = await readFile('/review-input/bundle.json')
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
  await inventory('/review-input')
  if (JSON.stringify([...actualEntries].sort()) !== JSON.stringify([...expectedEntries].sort()))
    throw new Error('bundle tree differs inside reviewer container')
  for (const file of bundle.files) {
    const bytes = await readFile(`/review-input/${file.path}`)
    if (
      bytes.byteLength !== file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new Error('bundle file differs inside reviewer container')
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
  const providerTimeoutMs = Number.parseInt(process.argv[9] ?? '', 10)
  const expectedAuthSha256 = process.argv[10] ?? ''
  if (
    invocation.executable !== provider ||
    invocation.cwd !== '/review-input' ||
    invocation.prompt.length === 0 ||
    (invocation.response.kind === 'file' && invocation.response.path !== '/out/response.txt') ||
    !Number.isSafeInteger(providerTimeoutMs) ||
    providerTimeoutMs <= 0 ||
    !/^[0-9a-f]{64}$/.test(expectedAuthSha256) ||
    (await boundedFileSha256(authPath)) !== expectedAuthSha256
  )
    throw new Error('review adapter invocation is outside the container runner contract')
  const versionProcess = Bun.spawn([invocation.executable, ...invocation.versionArgv], {
    cwd: invocation.cwd,
    env: invocation.environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [versionExit, versionStdout, versionStderr] = await Promise.all([
    versionProcess.exited,
    drainBounded(versionProcess.stdout, MAX_PROVIDER_VERSION_BYTES),
    drainBounded(versionProcess.stderr, MAX_PROVIDER_VERSION_BYTES),
  ])
  if (versionExit !== 0 || versionStdout.overflow || versionStderr.overflow)
    throw new Error('review provider version command failed')
  providerVersion = new TextDecoder('utf-8', { fatal: true }).decode(versionStdout.bytes).trim()
  const reviewProcess = Bun.spawn([invocation.executable, ...invocation.argv], {
    cwd: invocation.cwd,
    env: invocation.environment,
    stdin: new Blob([invocation.prompt]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const responseHandle =
    invocation.response.kind === 'stdout'
      ? await open('/out/response.txt', constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY)
      : undefined
  let responseOffset = 0
  const stdout = drainBounded(
    reviewProcess.stdout,
    MAX_PROVIDER_OUTPUT_BYTES,
    responseHandle === undefined
      ? undefined
      : async chunk => {
          await responseHandle.write(chunk, 0, chunk.byteLength, responseOffset)
          responseOffset += chunk.byteLength
          await responseHandle.sync()
        },
  )
  const stderr = drainBounded(reviewProcess.stderr, MAX_PROVIDER_OUTPUT_BYTES)
  let responseOverflow = false
  const responsePath = invocation.response.kind === 'file' ? invocation.response.path : undefined
  const responseMonitor =
    responsePath !== undefined
      ? setInterval(async () => {
          const metadata = await stat(responsePath).catch(() => undefined)
          if (metadata !== undefined && metadata.size > MAX_PROVIDER_OUTPUT_BYTES) {
            responseOverflow = true
            reviewProcess.kill('SIGTERM')
          }
        }, 25)
      : undefined
  let providerTimedOut = false
  const providerTimer = setTimeout(() => {
    providerTimedOut = true
    reviewProcess.kill('SIGTERM')
  }, providerTimeoutMs)
  const [reviewExit, reviewStdout, reviewStderr] = await Promise.all([
    reviewProcess.exited,
    stdout,
    stderr,
  ]).finally(async () => {
    clearTimeout(providerTimer)
    if (responseMonitor !== undefined) clearInterval(responseMonitor)
    await responseHandle?.close()
  })
  if (responsePath !== undefined) {
    const metadata = await stat(responsePath).catch(() => undefined)
    responseOverflow ||= metadata !== undefined && metadata.size > MAX_PROVIDER_OUTPUT_BYTES
  }
  if (reviewStdout.overflow || reviewStderr.overflow || responseOverflow)
    throw new Error('review provider command output exceeded its bound')
  if (providerTimedOut) process.exit(124)
  if (reviewExit !== 0) throw new Error('review provider command failed')
} else {
  await writeFile('/out/result.txt', 'fake-review-complete\n')
}
const routeTable = await readFile('/proc/net/route', 'utf8').catch(() => '')

console.log(
  JSON.stringify({
    providerVersion,
    uid: process.getuid?.() ?? -1,
    bundleReadable: await canRead(
      scenario === 'review' ? '/review-input/bundle.json' : '/bundle/input.json',
    ),
    bundleWriteBlocked: await writeIsBlocked(
      scenario === 'review' ? '/review-input/bundle.json' : '/bundle/input.json',
    ),
    authReadable: await canRead(authPath),
    authWriteBlocked: await writeIsBlocked(authPath),
    outputWritable: await canRead(scenario === 'review' ? '/out/response.txt' : '/out/result.txt'),
    forbiddenPathsAbsent,
    networkRoutePresent: routeTable.includes('eth0'),
  }),
)
