import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { resolveConfiguration } from '@factory/capture'
import { canonicalJson } from '@factory/contract'
import { openRepositoryStore, withAdvisoryFileLock } from '@factory/repository'

import { globalConfig } from './configuration'
import { atomicPrivateWrite, readBoundedOrdinaryFile } from './private-files'
import { factoryBuildIdentity } from './version'

type UpdateSource = 'npm' | 'standalone'
type UpdateObservation = { checkedAt: number; version: string | null; attemptedAt?: number }

function cachePath(environment: NodeJS.ProcessEnv, source: UpdateSource): string {
  return join(
    environment.XDG_CACHE_HOME ?? join(environment.HOME ?? homedir(), '.cache'),
    'factory',
    source === 'npm' ? 'npm-update-check.json' : 'update-check.json',
  )
}

export function stableVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)
  )
}

export async function updateChecksEnabled(
  repositoryRoot: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  let repository = {}
  if (repositoryRoot !== undefined) {
    try {
      repository = await (await openRepositoryStore(repositoryRoot)).readConfig()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return resolveConfiguration({}, repository, await globalConfig(environment)).updateChecks
}

async function discoverVersion(source: UpdateSource): Promise<string | undefined> {
  const response = await fetch(
    source === 'npm'
      ? 'https://registry.npmjs.org/@dzhng%2ffactory/latest'
      : 'https://api.github.com/repos/dzhng/factory/releases/latest',
    {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': 'Factory update check' },
    },
  )
  if (source === 'standalone' && response.status === 404) return undefined
  if (!response.ok || !response.body) throw new Error('Release discovery unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 64 * 1024) throw new Error('Release discovery exceeds size bound')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const version =
    source === 'npm'
      ? value?.version
      : typeof value?.tag_name === 'string'
        ? value.tag_name.replace(/^v/, '')
        : undefined
  if (
    !stableVersion(version) ||
    (source === 'standalone' && (value.draft !== false || value.prerelease !== false))
  )
    throw new Error('Release discovery is not a stable release')
  return version
}

export async function latestNpmVersion(): Promise<string> {
  const version = await discoverVersion('npm')
  if (version === undefined) throw new Error('No npm release found')
  return version
}

/** Observations never authorize executable replacement. */
export async function refreshUpdateCheck(
  environment: NodeJS.ProcessEnv,
  source: UpdateSource = 'standalone',
): Promise<string | undefined> {
  const version = await discoverVersion(source)
  await atomicPrivateWrite(
    cachePath(environment, source),
    Buffer.from(canonicalJson({ checkedAt: Date.now(), version: version ?? null })),
  )
  return version
}

async function readObservation(
  environment: NodeJS.ProcessEnv,
  source: UpdateSource,
): Promise<UpdateObservation | undefined> {
  try {
    const bytes = await readBoundedOrdinaryFile(cachePath(environment, source), 4096)
    if (!bytes) return undefined
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (
      (!stableVersion(value.version) && value.version !== null) ||
      !Number.isFinite(value.checkedAt) ||
      value.checkedAt < 0 ||
      value.checkedAt > Date.now() ||
      (value.attemptedAt !== undefined &&
        (!Number.isFinite(value.attemptedAt) ||
          value.attemptedAt < 0 ||
          value.attemptedAt > Date.now()))
    )
      return undefined
    return value
  } catch {
    return undefined
  }
}

function checkDue(value: UpdateObservation | undefined): boolean {
  return !value || Date.now() - (value.attemptedAt ?? value.checkedAt) >= 24 * 60 * 60 * 1000
}

export async function cachedUpdateWarning(
  environment: NodeJS.ProcessEnv,
  source: UpdateSource = 'standalone',
): Promise<string | undefined> {
  const value = await readObservation(environment, source)
  if (
    !value?.version ||
    Date.now() - value.checkedAt > 7 * 24 * 60 * 60 * 1000 ||
    Bun.semver.order(factoryBuildIdentity.version, value.version) !== -1
  )
    return undefined
  return source === 'npm'
    ? `Factory ${value.version} is available. Run factory upgrade.\n`
    : `Factory ${value.version} is available: https://github.com/dzhng/factory/releases/latest. No update was installed.\n`
}

/** A detached checker survives a short CLI invocation without holding it open. */
export async function scheduleUpdateCheck(
  environment: NodeJS.ProcessEnv,
  source: UpdateSource,
  command: readonly string[],
): Promise<void> {
  if (!checkDue(await readObservation(environment, source))) return
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), '_update-check', source], {
      env: environment,
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function backgroundUpdateCheck(
  environment: NodeJS.ProcessEnv,
  source: UpdateSource,
): Promise<void> {
  const path = cachePath(environment, source)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withAdvisoryFileLock(
    `${path}.lock`,
    0,
    async () => {
      const value = await readObservation(environment, source)
      if (!checkDue(value)) return
      // Persist the attempt before network I/O so offline launches and crashes cannot retry-loop.
      await atomicPrivateWrite(
        path,
        Buffer.from(
          canonicalJson({ ...(value ?? { checkedAt: 0, version: null }), attemptedAt: Date.now() }),
        ),
      )
      try {
        await refreshUpdateCheck(environment, source)
      } catch {
        /* Keep the last observation. */
      }
    },
    () => {},
  )
}
