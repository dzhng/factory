import { spawn } from 'node:child_process'

export type ReviewerCommandResult =
  | { kind: 'completed'; exitCode: number; stdout: Uint8Array; stderr: Uint8Array }
  | { kind: 'missing' | 'timeout' | 'output-limit'; stdout: Uint8Array; stderr: Uint8Array }

/** Run a fixed external boundary without allowing time or output to grow without bound. */
export async function runReviewerCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  options: { maximumBytes: number; timeoutMs: number },
): Promise<ReviewerCommandResult> {
  return await new Promise(resolve => {
    const child = spawn(command, [...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let retainedBytes = 0
    let terminalKind: 'timeout' | 'output-limit' | undefined
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => terminate('timeout'), options.timeoutMs)
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
      const retained = chunk.subarray(0, Math.max(0, options.maximumBytes - retainedBytes))
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
