import { spawn } from 'node:child_process'

import type { CaptureProvider } from '@factory/runtime-journal'

export type ProviderCommandResult =
  | { kind: 'completed'; exitCode: number; stdout: Uint8Array; stderr: Uint8Array }
  | { kind: 'missing' | 'timeout' | 'output-limit'; stdout: Uint8Array; stderr: Uint8Array }

export type CaptureProviderEnvironmentInspection = Record<
  CaptureProvider,
  | { availability: 'available'; version: string }
  | {
      availability: 'unavailable'
      reason: 'missing' | 'timeout' | 'output-limit' | 'command-failed' | 'malformed-response'
    }
>

export type CaptureProviderEnvironmentOptions = {
  run?: (provider: CaptureProvider) => Promise<ProviderCommandResult>
  executables?: Partial<Record<CaptureProvider, string>>
  maximumBytes?: number
  maximumDurationMs?: number
}

async function runBoundedProvider(
  executable: string,
  environment: NodeJS.ProcessEnv,
  maximumBytes: number,
  maximumDurationMs: number,
): Promise<ProviderCommandResult> {
  return await new Promise(resolve => {
    const child = spawn(executable, ['--version'], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let retainedBytes = 0
    let terminalKind: 'timeout' | 'output-limit' | undefined
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => terminate('timeout'), maximumDurationMs)
    const snapshot = () => ({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    const finish = (result: ProviderCommandResult) => {
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
      const retained = chunk.subarray(0, Math.max(0, maximumBytes - retainedBytes))
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
      } as ProviderCommandResult),
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

function classifyProvider(
  result: ProviderCommandResult,
): CaptureProviderEnvironmentInspection[CaptureProvider] {
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

export async function inspectCaptureProviderEnvironment(
  environment: NodeJS.ProcessEnv,
  options: CaptureProviderEnvironmentOptions = {},
): Promise<CaptureProviderEnvironmentInspection> {
  const maximumBytes = options.maximumBytes ?? 4_096
  const maximumDurationMs = options.maximumDurationMs ?? 5_000
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new TypeError('provider version output bound must be a positive integer')
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1)
    throw new TypeError('provider version deadline must be a positive integer')
  const run =
    options.run ??
    ((provider: CaptureProvider) =>
      runBoundedProvider(
        options.executables?.[provider] ?? provider,
        environment,
        maximumBytes,
        maximumDurationMs,
      ))
  const [codex, claude] = await Promise.all([
    run('codex').then(classifyProvider),
    run('claude').then(classifyProvider),
  ])
  return { codex, claude }
}
