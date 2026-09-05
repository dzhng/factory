import {
  resolveReviewerAuthentication,
  type ReviewerAuthenticationOptions,
} from './authentication.js'
import { runReviewerCommand, type ReviewerCommandResult } from './command.js'
import type { ReviewerProvider } from './isolation.js'

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

const MAX_COMMAND_BYTES = 4_096
const MAX_COMMAND_DURATION_MS = 5_000

async function runBounded(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ReviewerCommandResult> {
  return await runReviewerCommand(command, args, environment, {
    maximumBytes: MAX_COMMAND_BYTES,
    timeoutMs: MAX_COMMAND_DURATION_MS,
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

export async function inspectReviewerEnvironment(
  environment: NodeJS.ProcessEnv,
  run: (args: readonly string[]) => Promise<ReviewerCommandResult> = args =>
    runBounded('docker', args, environment),
  authenticationOptions: ReviewerAuthenticationOptions = {},
): Promise<ReviewerEnvironmentInspection> {
  const [docker, credentials] = await Promise.all([
    inspectDocker(environment, run),
    resolveReviewerAuthentication(environment, authenticationOptions).then(
      result => result.inspection,
    ),
  ])
  return { docker, credentials }
}
