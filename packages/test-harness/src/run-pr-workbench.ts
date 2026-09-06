import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

import {
  githubRepositoryKey,
  type RepositoryId,
  type Sha256,
  type AvailablePullRequestObservation,
  ObjectRef,
  RecordId,
} from '@factory/contract'
import { deriveAssociations, explainAssociations, verifyAssociationBatch } from '@factory/domain'
import {
  GithubPrObserver,
  observeGithubRepositoryMapping,
  persistPullRequestEvidence,
  type GhCommandResult,
  type PrObjectStore,
} from '@factory/github'
import { initializeRepositoryStore } from '@factory/repository'
import { createSanitizer } from '@factory/sanitization'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const evidenceRoot =
  process.env.FACTORY_PR_REPORT_ROOT ??
  resolve(repositoryRoot, 'specs/done/evidence-sanitization/assets/pr-workbench')
if (process.env.FACTORY_DOCKER_TEST !== '1') {
  const tests = Bun.spawn(['bun', 'run', '--cwd', 'packages/github', 'test'], {
    cwd: repositoryRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await tests.exited) !== 0) process.exit(1)
  await mkdir(evidenceRoot, { recursive: true })
  const report = Bun.spawn(
    [
      'docker',
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=128m',
      '--mount',
      `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
      '--mount',
      `type=bind,src=${evidenceRoot},dst=/output`,
      '--workdir',
      '/tmp',
      '--env',
      'FACTORY_DOCKER_TEST=1',
      '--env',
      'FACTORY_PR_REPORT_ROOT=/output',
      'oven/bun:1.3.14',
      'bun',
      '/workspace/packages/test-harness/src/run-pr-workbench.ts',
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  process.exit(await report.exited)
}

const key = (value: string) => githubRepositoryKey('github.com', `R_${value}`)
const id = (value: string) => `${value}_${'0'.repeat(26)}` as RecordId
const head = '3'.repeat(40)
const session = (sessionKey: string, repositoryId: RepositoryId, gitHead: string) => {
  const observationId = id(`observation-${sessionKey}`)
  return {
    provider: 'codex' as const,
    turn: {
      schemaVersion: 1 as const,
      turnId: id(`turn-${sessionKey}`),
      sessionKey,
      nativeStopId: `stop-${sessionKey}`,
      capturedAt: '2026-09-05T00:00:00Z',
      materializedAt: '2026-09-05T00:00:00Z',
      eventRange: { first: 0, last: 0 },
      transcriptObservations: [],
      evidenceObjects: [],
      repositoryObservationId: observationId,
      limitations: [],
      captureAdapterVersion: 'workbench',
      formatVersion: 1 as const,
      inventory: [],
    },
    repositoryObservation: {
      schemaVersion: 1 as const,
      observationId,
      repositoryId,
      observedAt: '2026-09-05T00:00:00Z',
      completedAt: '2026-09-05T00:00:00Z',
      git: { head: gitHead, detached: false },
      changedPaths: [],
      worktreeFingerprint: '0'.repeat(64) as Sha256,
      limitations: [],
      startState: '1'.repeat(64) as Sha256,
      endState: '1'.repeat(64) as Sha256,
    },
  }
}
const localRepositoryId = 'repo_workbench' as RepositoryId
const observation: AvailablePullRequestObservation = {
  schemaVersion: 1,
  observationId: id('pr-observation'),
  provider: 'github',
  repositoryKey: key('base'),
  number: 42,
  availability: 'available',
  completeness: 'complete',
  commitMembership: 'complete',
  codeAvailability: 'unavailable',
  externalId: 'PR_42',
  hostname: 'github.com',
  url: 'https://github.com/owner/repo/pull/42',
  state: 'open',
  base: {
    repositoryKey: key('base'),
    externalId: 'R_base',
    repository: 'owner/repo',
    ref: 'main',
    sha: '1'.repeat(40),
  },
  head: {
    repositoryKey: key('fork'),
    externalId: 'R_fork',
    repository: 'contributor/repo',
    ref: 'feature',
    sha: head,
  },
  commits: ['2'.repeat(40), head],
  observedAt: '2026-09-05T01:00:00Z',
  providerUpdatedAt: '2026-09-05T00:00:00Z',
  evidence: [
    {
      algorithm: 'sha256',
      sha256: 'a'.repeat(64),
      bytes: 1,
      mediaType: 'application/json',
      role: 'github-pr-metadata',
    },
  ],
  diff: {
    algorithm: 'sha256',
    sha256: 'b'.repeat(64),
    bytes: 1,
    mediaType: 'text/x-diff',
    role: 'pull-request-diff',
  },
  limitations: [{ code: 'unavailable-pull-request-code', detail: 'Fixture has no code manifest' }],
}
const explanations = explainAssociations({
  pullRequest: observation,
  sessions: [
    session('exact-commit', localRepositoryId, '2'.repeat(40)),
    session('fork-head', localRepositoryId, head),
    session('ambiguous-context', localRepositoryId, '9'.repeat(40)),
  ],
  repositoryMappings: [],
})
const complete = (stdout: string): GhCommandResult => ({
  kind: 'completed',
  exitCode: 0,
  stdout: Buffer.from(stdout),
  stderr: new Uint8Array(),
})
const objects: PrObjectStore = {
  put: async (bytes, metadata): Promise<ObjectRef> => ({
    algorithm: 'sha256',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    ...metadata,
  }),
}
const metadata = (
  input: {
    repositoryId?: string
    state?: 'OPEN' | 'CLOSED' | 'MERGED'
    merged?: boolean
    head?: string
    commits?: string[]
    more?: boolean
  } = {},
) =>
  JSON.stringify({
    data: {
      repository: {
        id: input.repositoryId ?? 'R_base',
        nameWithOwner: 'owner/repo',
        url: 'https://github.com/owner/repo',
        pullRequest: {
          id: 'PR_42',
          url: 'https://github.com/owner/repo/pull/42',
          number: 42,
          state: input.merged ? 'MERGED' : (input.state ?? 'OPEN'),
          mergedAt: input.merged ? '2026-09-05T00:00:00Z' : null,
          baseRefName: 'main',
          baseRefOid: '1'.repeat(40),
          headRefName: 'feature',
          headRefOid: input.head ?? head,
          updatedAt: '2026-09-05T00:00:00Z',
          headRepository: {
            id: input.repositoryId ?? 'R_base',
            nameWithOwner: 'owner/repo',
            url: 'https://github.com/owner/repo',
          },
          commits: {
            nodes: (input.commits ?? ['2'.repeat(40), input.head ?? head]).map(oid => ({
              commit: { oid },
            })),
            pageInfo: { hasNextPage: input.more ?? false, endCursor: input.more ? 'next' : null },
          },
        },
      },
    },
  })
const observe = async (results: GhCommandResult[], maxCommits = 250) =>
  new GithubPrObserver({
    sanitizer: createSanitizer([]),
    run: async () => {
      const next = results.shift()
      if (!next) throw new Error('workbench exhausted gh fixture')
      return next
    },
    objects,
    maxCommits,
    now: () => new Date('2026-09-05T01:00:00Z'),
  }).observe({ hostname: 'github.com', owner: 'owner', name: 'repo', number: 42 })
const prior = deriveAssociations({
  pullRequest: observation,
  sessions: [session('force-pushed', localRepositoryId, '2'.repeat(40))],
  repositoryMappings: [],
})[0]!
const moved = {
  ...observation,
  observationId: id('pr-observation-moved'),
  observedAt: '2026-09-05T02:00:00Z',
  head: { ...observation.head, sha: '4'.repeat(40) },
  commits: ['4'.repeat(40)] as [string, ...string[]],
}
const invalidation = deriveAssociations({
  pullRequest: moved,
  sessions: [],
  previous: [{ pullRequest: observation, association: prior }],
  repositoryMappings: [],
})
const baseChangedObservation: AvailablePullRequestObservation = {
  ...observation,
  observationId: id('pr-observation-base-changed'),
  observedAt: '2026-09-05T03:00:00Z',
  base: { ...observation.base, sha: '8'.repeat(40) },
}
const baseChanged = deriveAssociations({
  pullRequest: baseChangedObservation,
  sessions: [session('base-changed', localRepositoryId, '2'.repeat(40))],
  repositoryMappings: [],
})
const secondPullRequest: AvailablePullRequestObservation = {
  ...observation,
  observationId: id('pr-observation-77'),
  number: 77,
  externalId: 'PR_77',
  url: 'https://github.com/owner/repo/pull/77',
  observedAt: '2026-09-05T04:00:00Z',
}
const sharedSession = session('shared-session', localRepositoryId, head)
const sessionAcrossPullRequests = [observation, secondPullRequest].flatMap(pullRequest =>
  deriveAssociations({
    pullRequest,
    sessions: [sharedSession],
    repositoryMappings: [],
  }),
)
const missing = await observe([
  { kind: 'missing', stdout: new Uint8Array(), stderr: new Uint8Array() },
])
const unauthenticated = await observe([
  {
    kind: 'completed',
    exitCode: 1,
    stdout: new Uint8Array(),
    stderr: Buffer.from('login required'),
  },
])
const cappedFixture = metadata({ commits: [head], more: true })
const capped = await observe(
  [complete(cappedFixture), complete('diff'), complete(cappedFixture)],
  1,
)
const deletedForkValue = JSON.parse(metadata()) as {
  data: { repository: { pullRequest: { headRepository: unknown } } }
}
deletedForkValue.data.repository.pullRequest.headRepository = null
const deletedForkFixture = JSON.stringify(deletedForkValue)
const deletedFork = await observe([
  complete(deletedForkFixture),
  complete('diff'),
  complete(deletedForkFixture),
])
const deletedRefValue = JSON.parse(metadata()) as {
  data: {
    repository: {
      pullRequest: { headRepository: unknown; headRefName: unknown; headRefOid: unknown }
    }
  }
}
deletedRefValue.data.repository.pullRequest.headRepository = null
deletedRefValue.data.repository.pullRequest.headRefName = null
deletedRefValue.data.repository.pullRequest.headRefOid = null
const deletedRefFixture = JSON.stringify(deletedRefValue)
const deletedRef = await observe([
  complete(deletedRefFixture),
  complete('diff'),
  complete(deletedRefFixture),
])
const batchAssociations = deriveAssociations({
  pullRequest: observation,
  sessions: [session('batched', localRepositoryId, head)],
  repositoryMappings: [],
  manual: [
    {
      sessionKey: 'manual-batched',
      actor: 'developer',
      reason: 'workbench assertion',
      observedAt: '2026-09-05T02:00:00Z',
    },
  ],
})
const batchRoot = await mkdtemp(join(tmpdir(), 'factory-pr-report-'))
await mkdir(join(batchRoot, '.git'))
const batchStore = await initializeRepositoryStore(
  batchRoot,
  {
    schemaVersion: 1,
    format: 'factory-repository',
    minimumReaderVersion: '0.1.0',
    repositoryId: localRepositoryId,
    createdAt: '2026-09-05T00:00:00Z',
  },
  {},
)
const preparation = await batchStore.preparePublication()
const associationRoot = join(
  batchRoot,
  '.factory',
  'pull-requests',
  'github',
  observation.repositoryKey,
  String(observation.number),
  'associations',
  observation.observationId,
)
await mkdir(associationRoot, { recursive: true })
const blockedBatchDirectory = join(associationRoot, 'batches')
await writeFile(blockedBatchDirectory, 'synthetic publication interruption')
try {
  await persistPullRequestEvidence(batchStore, observation, batchAssociations, { preparation })
  throw new Error('expected publication interruption')
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes('requires a directory')) throw error
}
const orphanPrefixesIgnored =
  (await readdir(associationRoot)).filter(path => path.endsWith('.json')).length ===
  batchAssociations.length
await unlink(blockedBatchDirectory)
const completedBatches = await persistPullRequestEvidence(
  batchStore,
  observation,
  batchAssociations,
  { preparation },
)
const batchesVerified = completedBatches.every(batch =>
  verifyAssociationBatch(
    batch,
    observation,
    batchAssociations.filter(record =>
      batch.evidence.some(item => item.evidenceId === record.evidenceId),
    ),
  ),
)
const lifecycle = await Promise.all([
  observe([
    complete(metadata({ state: 'CLOSED' })),
    complete('diff'),
    complete(metadata({ state: 'CLOSED' })),
  ]),
  observe([
    complete(metadata({ state: 'CLOSED', merged: true })),
    complete('diff'),
    complete(metadata({ state: 'CLOSED', merged: true })),
  ]),
  observe([
    complete(metadata({ state: 'OPEN' })),
    complete('diff'),
    complete(metadata({ state: 'OPEN' })),
  ]),
])
const mapping = (hostname: string, repository: string) =>
  observeGithubRepositoryMapping(localRepositoryId, hostname, {
    sanitizer: createSanitizer([]),
    run: async () =>
      complete(
        JSON.stringify({
          id: 'R_stable',
          nameWithOwner: repository,
          url: `https://${hostname}/${repository}`,
        }),
      ),
    objects,
    now: () => new Date('2026-09-05T01:00:00Z'),
  })
const [stableBefore, stableAfter, enterprise] = await Promise.all([
  mapping('github.com', 'owner/repo'),
  mapping('github.com', 'renamed/repo'),
  mapping('github.example.com', 'owner/repo'),
])
const sanitizedEvidence: string[] = []
const sanitized = await new GithubPrObserver({
  sanitizer: createSanitizer(['VALUE=synthetic-report-credential']),
  objects: {
    put: async (bytes, metadata) => {
      sanitizedEvidence.push(Buffer.from(bytes).toString())
      return objects.put(bytes, metadata)
    },
  },
  run: async args =>
    complete(
      args[0] === 'pr'
        ? 'diff --git a/reason.txt b/reason.txt\n--- a/reason.txt\n+++ b/reason.txt\n@@ -0,0 +1 @@\n+Retain reasoning synthetic-report-credential\ndiff --git a/.env b/.env\n+X=abc\n'
        : metadata(),
    ),
}).observe({ hostname: 'github.com', owner: 'owner', name: 'repo', number: 42 })
if (
  sanitized.availability !== 'available' ||
  sanitizedEvidence.join('').includes('synthetic-report-credential')
)
  throw new Error('sanitized PR report did not preserve safe readable evidence')
const scenarios = [
  {
    scenario: 'sanitized-review-evidence',
    result: 'retained reasoning; redacted credential; omitted env patch',
    reason: sanitized.transformation?.omissionReasons.join(', ') ?? 'FAILED',
  },
  ...explanations.map(item => ({
    scenario: item.sessionKey,
    result: item.accepted ? 'associated' : 'not associated',
    reason: item.reason,
  })),
  {
    scenario: 'one-pr-many-sessions',
    result:
      explanations.filter(item => item.accepted).length === 2
        ? 'two exact Sessions associated'
        : 'FAILED',
    reason: 'each Session is gated independently against one immutable PR observation',
  },
  {
    scenario: 'force-pushed',
    result: invalidation.some(item => item.kind === 'invalidation')
      ? 'history retained; invalidation appended'
      : 'FAILED',
    reason: 'old exact SHA absent from new complete set',
  },
  {
    scenario: 'base-changed',
    result:
      baseChanged[0]?.kind === 'commit' &&
      baseChanged[0]?.pullRequestObservationId === baseChangedObservation.observationId &&
      observation.base.sha === '1'.repeat(40)
        ? 'association retained; full PR subject changed'
        : 'FAILED',
    reason: 'exact contribution commit remains',
  },
  {
    scenario: 'renamed-repository',
    result:
      'repositoryKey' in stableBefore &&
      'repositoryKey' in stableAfter &&
      stableBefore.repositoryKey === stableAfter.repositoryKey
        ? 'same identity'
        : 'FAILED',
    reason: 'host plus provider repository ID, not owner/name',
  },
  {
    scenario: 'GHES',
    result:
      'repositoryKey' in stableBefore &&
      'repositoryKey' in enterprise &&
      stableBefore.repositoryKey !== enterprise.repositoryKey
        ? 'separate identity'
        : 'FAILED',
    reason: 'hostname is part of the identity digest',
  },
  {
    scenario: 'unauthenticated',
    result: unauthenticated.availability === 'unavailable' ? unauthenticated.reason : 'FAILED',
    reason: 'no exact fields published',
  },
  {
    scenario: 'missing-gh',
    result: missing.availability === 'unavailable' ? missing.reason : 'FAILED',
    reason: 'local capture and workspace review remain available',
  },
  {
    scenario: 'commit-cap',
    result:
      capped.availability === 'available' && capped.completeness === 'partial'
        ? 'partial review remains eligible'
        : 'FAILED',
    reason: 'bounded prefix disables commit membership but preserves coherent diff',
  },
  {
    scenario: 'deleted-fork',
    result:
      deletedFork.availability === 'available' && deletedFork.completeness === 'partial'
        ? 'partial review remains eligible'
        : 'FAILED',
    reason: 'readable coherent diff survives missing head repository identity',
  },
  {
    scenario: 'deleted-ref',
    result:
      deletedRef.availability === 'available' &&
      deletedRef.completeness === 'partial' &&
      deletedRef.head.sha === undefined
        ? 'partial review remains eligible; no automatic association'
        : 'FAILED',
    reason: 'the diff remains reviewable while exact head proof is absent',
  },
  {
    scenario: 'one-session-many-prs',
    result:
      sessionAcrossPullRequests.length === 2 &&
      new Set(sessionAcrossPullRequests.map(item => item.pullRequestObservationId)).size === 2
        ? 'two independently scoped associations'
        : 'FAILED',
    reason: 'the same exact Git object may contribute to more than one PR',
  },
  {
    scenario: 'association-crash-prefix',
    result:
      orphanPrefixesIgnored && batchesVerified
        ? 'orphan ignored; retry committed both batches'
        : 'FAILED',
    reason: 'only immutable completion markers publish association evidence',
  },
  {
    scenario: 'closed / merged / reopened',
    result: lifecycle
      .map(item => (item.availability === 'available' ? item.state : 'FAILED'))
      .join(' / '),
    reason: 'provider state is never rewritten',
  },
]
if (scenarios.some(scenario => scenario.result.includes('FAILED')))
  throw new Error('PR workbench scenario failed')
await mkdir(evidenceRoot, { recursive: true })
await writeFile(
  resolve(evidenceRoot, 'report.json'),
  `${JSON.stringify({ schemaVersion: 1, scenarios, sanitizedEvidence }, null, 2)}\n`,
)
const rows = scenarios
  .map(item => `<tr><th>${item.scenario}</th><td>${item.result}</td><td>${item.reason}</td></tr>`)
  .join('\n')
await writeFile(
  resolve(evidenceRoot, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Factory PR evidence workbench</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#18212b}table{border-collapse:collapse;width:100%}th,td{padding:12px;border-bottom:1px solid #ccd4dc;text-align:left}th{width:22%}thead{background:#edf2f7}</style><h1>PR observation and association workbench</h1><p>Only exact Git identity creates an automatic Session association. Every rejection remains visible.</p><table><thead><tr><th>Scenario</th><th>Outcome</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table>\n`,
)
