import { UnsupportedRepositoryVersionError, type RecordId } from '@factory/contract'
import { buildUiProjection, buildUnavailableUiProjection } from '@factory/domain'
import { observeGithubDefaultBranch } from '@factory/github'
import { openRepositoryStore, type RepositoryStore } from '@factory/repository'
import {
  acceptPartialCoverageByReviewId,
  appendDecisionAction,
  StaleDecisionActionError,
} from '@factory/review'
import {
  serveLocalUi,
  UiActionConflictError,
  type LocalUiHandle,
  type UiDecisionAction,
} from '@factory/web'

import { githubDiagnostics } from './diagnostics'

type Output = { stdout(value: string): void; stderr(value: string): void }

export type OpenCommandOptions = {
  signal?: AbortSignal
  launchBrowser?(url: string): Promise<void>
  onStarted?(handle: LocalUiHandle): void
}

async function defaultBrowser(url: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = Bun.spawn([command, url], {
    env: { PATH: environment.PATH ?? '/usr/bin:/bin' },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  if ((await child.exited) !== 0) throw new Error('browser launcher exited unsuccessfully')
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}

/** Compose the short-lived server without granting the presentation layer a repository handle. */
export async function openCommand(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  output: Output,
  options: OpenCommandOptions = {},
): Promise<void> {
  let store: RepositoryStore | undefined
  let unavailable: 'corrupt' | 'upgrade-required' | undefined
  try {
    store = await openRepositoryStore(repositoryRoot)
  } catch (error) {
    unavailable =
      error instanceof UnsupportedRepositoryVersionError ? 'upgrade-required' : 'corrupt'
  }
  const requireStore = (): RepositoryStore => {
    if (store === undefined) throw new UiActionConflictError()
    return store
  }
  const handle = await serveLocalUi({
    host: '127.0.0.1',
    snapshot: async purpose => {
      if (unavailable !== undefined) return buildUnavailableUiProjection(unavailable)
      try {
        const [records, github] = await Promise.all([
          requireStore().readRecords(),
          purpose === 'display'
            ? observeGithubDefaultBranch({
                cwd: repositoryRoot,
                environment,
                maximumDurationMs: 750,
              })
            : undefined,
        ])
        const snapshot = buildUiProjection(records)
        if (snapshot.state !== 'ready' || github === undefined) return snapshot
        return {
          ...snapshot,
          diagnostics: [
            ...snapshot.diagnostics,
            ...githubDiagnostics(github, records.config.canonicalBranch).map(item => ({
              priority: item.severity === 'high' ? ('high' as const) : ('normal' as const),
              message: item.summary,
            })),
          ],
        }
      } catch (error) {
        return buildUnavailableUiProjection(
          error instanceof UnsupportedRepositoryVersionError ? 'upgrade-required' : 'corrupt',
        )
      }
    },
    actions: {
      async appendDecision(action: UiDecisionAction) {
        try {
          await appendDecisionAction(requireStore(), action)
        } catch (error) {
          if (error instanceof StaleDecisionActionError) throw new UiActionConflictError()
          throw error
        }
      },
      async acceptCoverage(reviewId: RecordId) {
        await acceptPartialCoverageByReviewId(requireStore(), reviewId)
      },
    },
  })
  options.onStarted?.(handle)
  output.stdout(`${handle.origin}\n`)
  try {
    await (options.launchBrowser ?? (url => defaultBrowser(url, environment)))(handle.origin)
  } catch {
    output.stderr(`Could not open a browser. Visit ${handle.origin}\n`)
  }

  const controller = new AbortController()
  const stop = () => controller.abort()
  const external = options.signal
  const externalStop = () => controller.abort()
  if (external?.aborted) controller.abort()
  else external?.addEventListener('abort', externalStop, { once: true })
  if (options.signal === undefined) {
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  }
  try {
    await Promise.race([handle.finished, aborted(controller.signal)])
  } finally {
    external?.removeEventListener('abort', externalStop)
    if (options.signal === undefined) {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
    await handle.stop()
  }
}
