import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveConfiguration } from '@factory/capture'
import { canonicalJson } from '@factory/contract'
import { openRepositoryStore } from '@factory/repository'

import { globalConfig } from './configuration'
import { atomicPrivateWrite, readBoundedOrdinaryFile } from './private-files'
import { factoryBuildIdentity } from './version'

const RELEASE_AUTHORITY = 'https://api.github.com/repos/dzhng/factory/releases/latest'
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000

function cachePath(environment: NodeJS.ProcessEnv): string {
  return join(
    environment.XDG_CACHE_HOME ?? join(environment.HOME ?? homedir(), '.cache'),
    'factory',
    'update-check.json',
  )
}

function stableVersion(value: unknown): value is string {
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
    // Uninitialized repositories have no policy yet; malformed initialized
    // policy is not permission to perform discovery.
    try {
      repository = await (await openRepositoryStore(repositoryRoot)).readConfig()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return resolveConfiguration({}, repository, await globalConfig(environment)).updateChecks
}

/** Discovery is advisory: it never downloads or authorizes executable bytes. */
export async function refreshUpdateCheck(
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(RELEASE_AUTHORITY, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Factory update check' },
    })
    if (response.status === 404) {
      await atomicPrivateWrite(
        cachePath(environment),
        new TextEncoder().encode(canonicalJson({ checkedAt: Date.now(), version: null })),
      )
      return undefined
    }
    if (!response.ok || response.body === null) throw new Error('Release discovery unavailable')
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
    let value: { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('Release discovery returned invalid JSON')
    }
    const version =
      typeof value.tag_name === 'string' ? value.tag_name.replace(/^v/, '') : undefined
    if (!stableVersion(version) || value.draft !== false || value.prerelease !== false)
      throw new Error('Release discovery is not a stable release')
    await atomicPrivateWrite(
      cachePath(environment),
      new TextEncoder().encode(canonicalJson({ checkedAt: Date.now(), version })),
    )
    return version
  } finally {
    clearTimeout(timer)
  }
}

export async function cachedUpdateWarning(
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const bytes = await readBoundedOrdinaryFile(cachePath(environment), 4096)
    if (bytes === undefined) return undefined
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
      checkedAt?: unknown
      version?: unknown
    }
    if (
      !stableVersion(value.version) ||
      typeof value.checkedAt !== 'number' ||
      value.checkedAt > Date.now() ||
      Date.now() - value.checkedAt > MAX_CACHE_AGE_MS
    )
      return undefined
    if (Bun.semver.order(factoryBuildIdentity.version, value.version) !== -1) return undefined
    return `Factory ${value.version} is available (cached check): https://github.com/dzhng/factory/releases/latest. No update was installed.\n`
  } catch {
    return undefined
  }
}
