import { join } from 'node:path'

import type { GlobalFactoryConfig } from '@factory/capture'
import {
  isGitBranchName,
  parseDockerLimits,
  type DockerLimits,
  type JsonValue,
} from '@factory/contract'

import { configRoot, readBoundedOrdinaryFile } from './private-files'

const textDecoder = new TextDecoder('utf-8', { fatal: true })

async function readJsonObject(path: string): Promise<Record<string, JsonValue>> {
  const bytes = await readBoundedOrdinaryFile(path, 1024 * 1024)
  if (bytes === undefined) return {}
  const value = JSON.parse(textDecoder.decode(bytes)) as unknown
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError(`${path} must contain a JSON object`)
  }
  return value as Record<string, JsonValue>
}

export async function globalConfig(environment: NodeJS.ProcessEnv): Promise<GlobalFactoryConfig> {
  const value = await readJsonObject(join(configRoot(environment), 'config.json'))
  if (value.dockerLimits !== undefined) parseDockerLimits(value.dockerLimits)
  if (value.updateChecks !== undefined && typeof value.updateChecks !== 'boolean')
    throw new TypeError('updateChecks must be boolean')
  if (
    value.repositoryInitialization !== undefined &&
    value.repositoryInitialization !== 'explicit' &&
    value.repositoryInitialization !== 'automatic'
  ) {
    throw new TypeError('repositoryInitialization is unsupported')
  }
  if (value.automaticReview !== undefined && typeof value.automaticReview !== 'boolean') {
    throw new TypeError('automaticReview must be boolean')
  }
  if (
    value.canonicalBranch !== undefined &&
    (typeof value.canonicalBranch !== 'string' || !isGitBranchName(value.canonicalBranch))
  ) {
    throw new TypeError('canonicalBranch must be a valid Git branch name')
  }
  if (
    value.reviewer !== undefined &&
    value.reviewer !== 'auto' &&
    (value.reviewer === null ||
      Array.isArray(value.reviewer) ||
      typeof value.reviewer !== 'object' ||
      (value.reviewer.provider !== 'codex' && value.reviewer.provider !== 'claude'))
  ) {
    throw new TypeError('reviewer is unsupported')
  }
  return value as GlobalFactoryConfig
}

export const dockerLimitFlags = {
  '--docker-memory-mib': 'memoryMiB',
  '--docker-cpus': 'cpus',
  '--docker-pids': 'pids',
  '--review-timeout-seconds': 'timeoutSeconds',
} as const

export function dockerLimitsFromArgs(args: readonly string[]): Partial<DockerLimits> | undefined {
  const limits: Partial<DockerLimits> = {}
  for (const [flag, key] of Object.entries(dockerLimitFlags)) {
    const index = args.indexOf(flag)
    if (index < 0) continue
    const value = args[index + 1]
    if (value === undefined || !/^\d+$/.test(value))
      throw new TypeError(`${flag} requires an integer`)
    limits[key] = Number(value)
  }
  return Object.keys(limits).length === 0 ? undefined : parseDockerLimits(limits)
}
