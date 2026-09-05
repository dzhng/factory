import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { reviewerAuthContainerPath } from './adapter.js'
import { dockerMountPathIssue, type ReadonlyAuthMount, type ReviewerProvider } from './isolation.js'

export type ReviewerCommandResult =
  | { kind: 'completed'; exitCode: number; stdout: Uint8Array; stderr: Uint8Array }
  | { kind: 'missing' | 'timeout' | 'output-limit'; stdout: Uint8Array; stderr: Uint8Array }

export type ReviewerEnvironmentInspection = {
  docker:
    | { availability: 'available'; version: string }
    | {
        availability: 'unavailable'
        reason: 'missing' | 'timeout' | 'output-limit' | 'command-failed' | 'malformed-response'
      }
  credentials: Record<
    ReviewerProvider,
    {
      state: 'available' | 'unconfigured' | 'invalid'
      reason?:
        | 'path-not-absolute'
        | 'mount-path-unsupported'
        | 'missing-or-unsafe'
        | 'too-large'
        | 'wrong-owner'
        | 'unreadable'
    }
  >
}

export type ReviewerAuthentication = {
  availability: Record<ReviewerProvider, boolean>
  mounts: Partial<Record<ReviewerProvider, Omit<ReadonlyAuthMount, 'mode'>>>
  inspection: ReviewerEnvironmentInspection['credentials']
}

const MAX_COMMAND_BYTES = 4_096
const MAX_COMMAND_DURATION_MS = 5_000
const MAX_AUTH_BYTES = 1024 * 1024

async function runBounded(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ReviewerCommandResult> {
  return await new Promise(resolve => {
    const child = spawn(command, [...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let retainedBytes = 0
    let terminalKind: 'timeout' | 'output-limit' | undefined
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => terminate('timeout'), MAX_COMMAND_DURATION_MS)
    const snapshot = () => ({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    const finish = (result: ReviewerCommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      resolve(result)
    }
    const terminate = (kind: 'timeout' | 'output-limit') => {
      if (settled || terminalKind !== undefined) return
      terminalKind = kind
      child.stdout.destroy()
      child.stderr.destroy()
      child.kill('SIGKILL')
      killTimer = setTimeout(() => finish({ kind, ...snapshot() }), 1_000)
    }
    const append = (target: Buffer[], chunk: Buffer) => {
      if (settled || terminalKind !== undefined) return
      const retained = chunk.subarray(0, Math.max(0, MAX_COMMAND_BYTES - retainedBytes))
      retainedBytes += retained.byteLength
      if (retained.byteLength > 0) target.push(retained)
      if (retained.byteLength < chunk.byteLength) terminate('output-limit')
    }
    child.stdout.on('data', chunk => append(stdout, Buffer.from(chunk)))
    child.stderr.on('data', chunk => append(stderr, Buffer.from(chunk)))
    child.on('error', error =>
      finish({
        kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'completed',
        exitCode: 127,
        ...snapshot(),
      } as ReviewerCommandResult),
    )
    child.on('close', code =>
      finish(
        terminalKind === undefined
          ? { kind: 'completed', exitCode: code ?? 1, ...snapshot() }
          : { kind: terminalKind, ...snapshot() },
      ),
    )
  })
}

async function inspectDocker(
  environment: NodeJS.ProcessEnv,
  runner: (args: readonly string[]) => Promise<ReviewerCommandResult>,
): Promise<ReviewerEnvironmentInspection['docker']> {
  const result = await runner(['version', '--format', '{{.Server.Version}}'])
  if (result.kind !== 'completed') return { availability: 'unavailable', reason: result.kind }
  if (result.exitCode !== 0) return { availability: 'unavailable', reason: 'command-failed' }
  let version: string
  try {
    version = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout).trim()
  } catch {
    return { availability: 'unavailable', reason: 'malformed-response' }
  }
  if (
    !version ||
    Buffer.byteLength(version) > 256 ||
    version.includes('\r') ||
    version.includes('\n') ||
    version.includes('\u0000')
  )
    return { availability: 'unavailable', reason: 'malformed-response' }
  return { availability: 'available', version }
}

export async function resolveReviewerAuthentication(
  environment: NodeJS.ProcessEnv,
): Promise<ReviewerAuthentication> {
  const configured = {
    codex: environment.FACTORY_CODEX_AUTH_FILE,
    claude: environment.FACTORY_CLAUDE_AUTH_FILE,
  }
  const mounts: ReviewerAuthentication['mounts'] = {}
  const availability = { codex: false, claude: false }
  const inspection = {} as ReviewerAuthentication['inspection']
  for (const provider of ['codex', 'claude'] as const) {
    const path = configured[provider]
    if (path === undefined) {
      inspection[provider] = { state: 'unconfigured' }
      continue
    }
    if (!isAbsolute(path)) {
      inspection[provider] = { state: 'invalid', reason: 'path-not-absolute' }
      continue
    }
    if (dockerMountPathIssue(path) !== undefined) {
      inspection[provider] = { state: 'invalid', reason: 'mount-path-unsupported' }
      continue
    }
    const metadata = await lstat(path).catch(() => undefined)
    if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile()) {
      inspection[provider] = { state: 'invalid', reason: 'missing-or-unsafe' }
      continue
    }
    if (metadata.size > MAX_AUTH_BYTES) {
      inspection[provider] = { state: 'invalid', reason: 'too-large' }
      continue
    }
    if (metadata.uid === 0 || metadata.uid !== process.getuid?.()) {
      inspection[provider] = { state: 'invalid', reason: 'wrong-owner' }
      continue
    }
    if ((metadata.mode & 0o400) === 0) {
      inspection[provider] = { state: 'invalid', reason: 'unreadable' }
      continue
    }
    const canonicalPath = await realpath(path).catch(() => undefined)
    const canonicalMetadata =
      canonicalPath === undefined ? undefined : await lstat(canonicalPath).catch(() => undefined)
    if (
      canonicalPath === undefined ||
      canonicalMetadata === undefined ||
      !canonicalMetadata.isFile() ||
      canonicalMetadata.dev !== metadata.dev ||
      canonicalMetadata.ino !== metadata.ino ||
      canonicalMetadata.size !== metadata.size ||
      canonicalMetadata.uid !== metadata.uid ||
      canonicalMetadata.mode !== metadata.mode
    ) {
      inspection[provider] = { state: 'invalid', reason: 'missing-or-unsafe' }
      continue
    }
    availability[provider] = true
    inspection[provider] = { state: 'available' }
    mounts[provider] = {
      hostPath: canonicalPath,
      containerPath: reviewerAuthContainerPath(provider),
      expectedIdentity: {
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        uid: metadata.uid,
        mode: metadata.mode,
      },
    }
  }
  return { availability, mounts, inspection }
}

export async function inspectReviewerEnvironment(
  environment: NodeJS.ProcessEnv,
  run: (args: readonly string[]) => Promise<ReviewerCommandResult> = args =>
    runBounded('docker', args, environment),
): Promise<ReviewerEnvironmentInspection> {
  const [docker, credentials] = await Promise.all([
    inspectDocker(environment, run),
    resolveReviewerAuthentication(environment).then(result => result.inspection),
  ])
  return { docker, credentials }
}
