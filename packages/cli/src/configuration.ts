import { join } from 'node:path'

import type { GlobalFactoryConfig } from '@factory/capture'
import { isGitBranchName, type JsonValue } from '@factory/contract'

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
