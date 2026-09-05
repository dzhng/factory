import { constants } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { platform as hostPlatform } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { reviewerAuthContainerPath } from './adapter.js'
import { runReviewerCommand, type ReviewerCommandResult } from './command.js'
import { dockerMountPathIssue, type ReadonlyAuthMount, type ReviewerProvider } from './isolation.js'

const MAX_AUTH_BYTES = 1024 * 1024
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

export type ReviewerCredentialSource =
  | {
      kind: 'file'
      mount: Omit<ReadonlyAuthMount, 'mode'>
    }
  | {
      kind: 'macos-keychain'
      service: typeof CLAUDE_KEYCHAIN_SERVICE
    }

export type ReviewerAuthentication = {
  availability: Record<ReviewerProvider, boolean>
  sources: Partial<Record<ReviewerProvider, ReviewerCredentialSource>>
  inspection: Record<
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

export type ReviewerAuthenticationOptions = {
  platform?: NodeJS.Platform
  runSecurity?: (args: readonly string[]) => Promise<ReviewerCommandResult>
}

type MaterializeOptions = {
  runSecurity?: (args: readonly string[]) => Promise<ReviewerCommandResult>
}

function claudeInferenceCredential(bytes: Uint8Array): Uint8Array {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('Claude Keychain credential is not bounded UTF-8 JSON')
  }
  if (value === null || typeof value !== 'object')
    throw new Error('Claude Keychain credential has no inference identity')
  const claudeAiOauth = (value as Record<string, unknown>).claudeAiOauth
  if (claudeAiOauth === null || typeof claudeAiOauth !== 'object')
    throw new Error('Claude Keychain credential has no inference identity')
  const credential = claudeAiOauth as Record<string, unknown>
  if (
    typeof credential.accessToken !== 'string' ||
    credential.accessToken.length === 0 ||
    typeof credential.refreshToken !== 'string' ||
    credential.refreshToken.length === 0
  )
    throw new Error('Claude Keychain credential has no usable inference token')
  return Buffer.from(JSON.stringify({ claudeAiOauth }))
}

/** Materialize only the selected credential inside one private review-attempt root. */
export async function materializeReviewerCredential(
  source: ReviewerCredentialSource,
  runtimeRoot: string,
  options: MaterializeOptions = {},
): Promise<{ mount: Omit<ReadonlyAuthMount, 'mode'>; root?: string }> {
  if (source.kind === 'file') return { mount: source.mount }
  const runSecurity =
    options.runSecurity ??
    (args =>
      runReviewerCommand('/usr/bin/security', args, process.env, {
        maximumBytes: MAX_AUTH_BYTES,
        timeoutMs: 5_000,
      }))
  const result = await runSecurity(['find-generic-password', '-w', '-s', source.service])
  if (result.kind !== 'completed' || result.exitCode !== 0)
    throw new Error('Claude Keychain credential became unavailable')
  const bytes = claudeInferenceCredential(result.stdout)
  const root = await mkdtemp(join(runtimeRoot, 'review-auth-'))
  await chmod(root, 0o700)
  const path = join(root, '.credentials.json')
  let handle
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    const metadata = await handle.stat()
    await handle.close()
    handle = undefined
    return {
      root,
      mount: {
        hostPath: path,
        containerPath: reviewerAuthContainerPath('claude'),
        expectedIdentity: {
          dev: metadata.dev,
          ino: metadata.ino,
          size: metadata.size,
          uid: metadata.uid,
          mode: metadata.mode,
        },
      },
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function fileSource(
  provider: ReviewerProvider,
  path: string,
): Promise<
  | { state: 'available'; source: ReviewerCredentialSource }
  | {
      state: 'invalid'
      reason: NonNullable<ReviewerAuthentication['inspection']['codex']['reason']>
    }
> {
  if (!isAbsolute(path)) return { state: 'invalid', reason: 'path-not-absolute' }
  if (dockerMountPathIssue(path) !== undefined)
    return { state: 'invalid', reason: 'mount-path-unsupported' }
  const metadata = await lstat(path).catch(() => undefined)
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile())
    return { state: 'invalid', reason: 'missing-or-unsafe' }
  if (metadata.size > MAX_AUTH_BYTES) return { state: 'invalid', reason: 'too-large' }
  if (metadata.uid === 0 || metadata.uid !== process.getuid?.())
    return { state: 'invalid', reason: 'wrong-owner' }
  if ((metadata.mode & 0o400) === 0) return { state: 'invalid', reason: 'unreadable' }
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
  )
    return { state: 'invalid', reason: 'missing-or-unsafe' }
  return {
    state: 'available',
    source: {
      kind: 'file',
      mount: {
        hostPath: canonicalPath,
        containerPath: reviewerAuthContainerPath(provider),
        expectedIdentity: {
          dev: metadata.dev,
          ino: metadata.ino,
          size: metadata.size,
          uid: metadata.uid,
          mode: metadata.mode,
        },
      },
    },
  }
}

export async function resolveReviewerAuthentication(
  environment: NodeJS.ProcessEnv,
  options: ReviewerAuthenticationOptions = {},
): Promise<ReviewerAuthentication> {
  const home = environment.HOME
  const configured = {
    codex: {
      explicit: environment.FACTORY_CODEX_AUTH_FILE !== undefined,
      path:
        environment.FACTORY_CODEX_AUTH_FILE ??
        (environment.CODEX_HOME === undefined
          ? home === undefined
            ? undefined
            : join(home, '.codex', 'auth.json')
          : join(environment.CODEX_HOME, 'auth.json')),
    },
    claude: {
      explicit: environment.FACTORY_CLAUDE_AUTH_FILE !== undefined,
      path:
        environment.FACTORY_CLAUDE_AUTH_FILE ??
        (environment.CLAUDE_CONFIG_DIR === undefined
          ? home === undefined
            ? undefined
            : join(home, '.claude', '.credentials.json')
          : join(environment.CLAUDE_CONFIG_DIR, '.credentials.json')),
    },
  }
  const sources: ReviewerAuthentication['sources'] = {}
  const availability = { codex: false, claude: false }
  const inspection = {} as ReviewerAuthentication['inspection']
  for (const provider of ['codex', 'claude'] as const) {
    const candidate = configured[provider]
    if (candidate.path !== undefined) {
      const result = await fileSource(provider, candidate.path)
      if (result.state === 'available') {
        availability[provider] = true
        inspection[provider] = { state: 'available' }
        sources[provider] = result.source
        continue
      }
      if (candidate.explicit || result.reason !== 'missing-or-unsafe') {
        inspection[provider] = result
        continue
      }
    }
    if (provider === 'claude' && (options.platform ?? hostPlatform()) === 'darwin') {
      const runSecurity =
        options.runSecurity ??
        (args =>
          runReviewerCommand('/usr/bin/security', args, environment, {
            maximumBytes: 4_096,
            timeoutMs: 5_000,
          }))
      const keychain = await runSecurity(['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE])
      if (keychain.kind === 'completed' && keychain.exitCode === 0) {
        availability.claude = true
        inspection.claude = { state: 'available' }
        sources.claude = { kind: 'macos-keychain', service: CLAUDE_KEYCHAIN_SERVICE }
        continue
      }
    }
    inspection[provider] = { state: 'unconfigured' }
  }
  return { availability, sources, inspection }
}
