import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveConfiguration } from '@factory/capture'
import type { RepositoryStore } from '@factory/repository'
import { locateGitCommonRuntime } from '@factory/runtime-journal'

import { globalConfig } from './configuration'

export async function automaticReviewLockPath(repositoryRoot: string): Promise<string> {
  const root = await realpath(repositoryRoot)
  return join(
    await locateGitCommonRuntime(root),
    `automatic-review-${createHash('sha256').update(root).digest('hex')}.lock`,
  )
}

/** Wake the installed CLI after capture; the review owner serializes execution and drains triggers. */
export async function scheduleAutomaticReview(
  repositoryRoot: string,
  store: RepositoryStore,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const config = resolveConfiguration({}, await store.readConfig(), await globalConfig(environment))
  if (!config.automaticReview) return
  // Compiled Bun executables embed their entrypoint under /$bunfs; source builds need the script argument.
  const args = [
    ...(Bun.main.startsWith('/$bunfs/') ? [] : [process.argv[1]!]),
    'review',
    '--automatic',
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
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
