import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  githubRepositoryKey,
  type ObjectRef,
  type PullRequestUnavailableReason,
  type RecordId,
  type RepositoryId,
  type Sha256,
} from '../../contract/src/index'
import { deriveAssociations } from '../../domain/src/index'
import { initializeRepositoryStore, type RepositoryStore } from '../../repository/src/index'
import {
  GithubPrObserver,
  observeGithubRepositoryMapping,
  persistPullRequestEvidence,
  runBoundedGh,
  verifyAssociationBatch,
  type GhCommandResult,
  type PrObjectStore,
} from '../src/index'

if (process.env.FACTORY_DOCKER_TEST !== '1') throw new Error('PR tests require Docker')
const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))),
)

const sha = (digit: string) => digit.repeat(40)
const id = (prefix: string, digit = '0') => `${prefix}_${digit.repeat(26)}` as RecordId
const sessionEvidence = (sessionKey: string, repositoryId: RepositoryId, head: string) => {
  const observationId = id('observation', '6')
  return {
    provider: 'codex' as const,
    turn: {
      schemaVersion: 1 as const,
      turnId: id('turn', '6'),
      sessionKey,
      nativeStopId: 'stop-fixture',
      capturedAt: '2026-09-05T00:00:00Z',
      materializedAt: '2026-09-05T00:00:00Z',
      eventRange: { first: 0, last: 0 },
      transcriptObservations: [],
      rawObjects: [],
      repositoryObservationId: observationId,
      limitations: [],
      captureAdapterVersion: 'fixture',
      formatVersion: 1 as const,
      inventory: [],
    },
    repositoryObservation: {
      schemaVersion: 1 as const,
      observationId,
      repositoryId,
      observedAt: '2026-09-05T00:00:00Z',
      completedAt: '2026-09-05T00:00:00Z',
      git: { head, detached: false },
      changedPaths: [],
      worktreeFingerprint: '0'.repeat(64) as Sha256,
      limitations: [],
      startState: '1'.repeat(64) as Sha256,
      endState: '1'.repeat(64) as Sha256,
    },
  }
}
const completed = (stdout: Uint8Array | string, stderr = ''): GhCommandResult => ({
  kind: 'completed',
  exitCode: 0,
  stdout: typeof stdout === 'string' ? Buffer.from(stdout) : stdout,
  stderr: Buffer.from(stderr),
})
class MemoryObjects implements PrObjectStore {
  async put(bytes: Uint8Array, metadata: { mediaType: string; role: string }): Promise<ObjectRef> {
    return {
      algorithm: 'sha256',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      ...metadata,
    }
  }
}
type MetadataFixture = {
  repositoryId?: string
  repositoryName?: string
  repositoryUrl?: string
  headRepositoryId?: string | null
  headRepositoryName?: string
  headRepositoryUrl?: string
  state?: 'OPEN' | 'CLOSED' | 'MERGED'
  merged?: boolean
  mergedAt?: string | null
  baseRef?: string | null
  baseSha?: string | null
  headRef?: string | null
  headSha?: string | null
  updatedAt?: string
  commits?: string[]
  hasNextPage?: boolean
  cursor?: string | null
  errors?: unknown
  url?: string
}
function metadata(fixture: MetadataFixture = {}): string {
  return JSON.stringify({
    ...(fixture.errors === undefined ? {} : { errors: fixture.errors }),
    data: {
      repository: {
        id: fixture.repositoryId ?? 'R_base',
        nameWithOwner: fixture.repositoryName ?? 'owner/repo',
        url: fixture.repositoryUrl ?? 'https://github.example.com/owner/repo',
        pullRequest: {
          id: 'PR_42',
          url: fixture.url ?? 'https://github.example.com/owner/repo/pull/42',
          number: 42,
          state: fixture.merged ? 'MERGED' : (fixture.state ?? 'OPEN'),
          mergedAt:
            fixture.mergedAt !== undefined
              ? fixture.mergedAt
              : fixture.merged
                ? '2026-09-05T00:00:00Z'
                : null,
          baseRefName: fixture.baseRef === undefined ? 'main' : fixture.baseRef,
          baseRefOid: fixture.baseSha === undefined ? sha('1') : fixture.baseSha,
          headRefName: fixture.headRef === undefined ? 'feature' : fixture.headRef,
          headRefOid: fixture.headSha === undefined ? sha('3') : fixture.headSha,
          updatedAt: fixture.updatedAt ?? '2026-09-05T00:00:00Z',
          headRepository:
            fixture.headRepositoryId === null
              ? null
              : {
                  id: fixture.headRepositoryId ?? fixture.repositoryId ?? 'R_base',
                  nameWithOwner:
                    fixture.headRepositoryName ??
                    (fixture.headRepositoryId === 'R_fork' ? 'contributor/repo' : 'owner/repo'),
                  url:
                    fixture.headRepositoryUrl ??
                    (fixture.headRepositoryId === 'R_fork'
                      ? 'https://github.example.com/contributor/repo'
                      : 'https://github.example.com/owner/repo'),
                },
          commits: {
            nodes: (fixture.commits ?? [sha('2'), sha('3')]).map(oid => ({ commit: { oid } })),
            pageInfo: {
              hasNextPage: fixture.hasNextPage ?? false,
              endCursor: fixture.cursor ?? null,
            },
          },
        },
      },
    },
  })
}
function observerFor(
  results: GhCommandResult[],
  options: { maxCommits?: number; maxCommitPages?: number } = {},
) {
  const calls: string[][] = []
  return {
    calls,
    observer: new GithubPrObserver({
      run: async args => {
        calls.push([...args])
        const result = results.shift()
        if (!result) throw new Error('unexpected gh call')
        return result
      },
      objects: new MemoryObjects(),
      ...options,
      now: () => new Date('2026-09-05T01:00:00Z'),
    }),
  }
}
const ref = { hostname: 'github.example.com', owner: 'owner', name: 'repo', number: 42 }

describe('bounded coherent GitHub observation', () => {
  test('freezes exact metadata/diff with fork and GHES identities', async () => {
    const fixture = metadata({ headRepositoryId: 'R_fork' })
    const { observer, calls } = observerFor([
      completed(fixture),
      completed('diff'),
      completed(fixture),
    ])
    const result = await observer.observe(ref)
    expect(result.availability).toBe('available')
    if (result.availability === 'available') {
      expect(result.repositoryKey).toBe(githubRepositoryKey(ref.hostname, 'R_base'))
      expect(result.head.repositoryKey).toBe(githubRepositoryKey(ref.hostname, 'R_fork'))
      expect(result.commits).toEqual([sha('2'), sha('3')])
    }
    expect(calls[1]).toEqual([
      'pr',
      'diff',
      '42',
      '--repo',
      'github.example.com/owner/repo',
      '--patch',
    ])
    expect(calls[0]).toContain('--hostname=github.example.com')
  })

  test('groups repository renames by provider identity and separates enterprise hosts', async () => {
    const fixture = metadata({ repositoryId: 'R_stable' })
    const before = await observerFor([
      completed(fixture),
      completed('diff'),
      completed(fixture),
    ]).observer.observe(ref)
    const after = await observerFor([
      completed(fixture),
      completed('diff'),
      completed(fixture),
    ]).observer.observe({
      ...ref,
      owner: 'renamed-owner',
      name: 'renamed-repo',
    })
    expect(before.availability === 'available' && before.repositoryKey).toBe(
      after.availability === 'available' && after.repositoryKey,
    )
    expect(before.availability === 'available' && before.repositoryKey).not.toBe(
      githubRepositoryKey('other.example.com', 'R_stable'),
    )
  })

  test('freezes provider-derived local repository mappings across rename and GHES', async () => {
    const local = 'repo_fixture' as RepositoryId
    const map = async (hostname: string, nameWithOwner: string) =>
      observeGithubRepositoryMapping(local, hostname, {
        run: async () =>
          completed(
            JSON.stringify({
              id: 'R_stable',
              nameWithOwner,
              url: `https://${hostname}/${nameWithOwner}`,
            }),
          ),
        objects: new MemoryObjects(),
        now: () => new Date('2026-09-05T01:00:00Z'),
      })
    const before = await map('github.com', 'owner/repo')
    const renamed = await map('github.com', 'renamed/repo')
    const enterprise = await map('github.example.com', 'owner/repo')
    expect('repositoryKey' in before && before.repositoryKey).toBe(
      'repositoryKey' in renamed && renamed.repositoryKey,
    )
    expect('repositoryKey' in before && before.repositoryKey).not.toBe(
      'repositoryKey' in enterprise && enterprise.repositoryKey,
    )
  })

  test('bounds repository mapping evidence storage within its acquisition deadline', async () => {
    const started = Date.now()
    const result = await observeGithubRepositoryMapping(
      'repo_fixture' as RepositoryId,
      'github.example.com',
      {
        run: async () =>
          completed(
            JSON.stringify({
              id: 'R_stable',
              nameWithOwner: 'owner/repo',
              url: 'https://github.example.com/owner/repo',
            }),
          ),
        objects: { put: async () => new Promise<ObjectRef>(() => {}) },
        maxAcquisitionDurationMs: 5,
        now: () => new Date('2026-09-05T01:00:00Z'),
      },
    )

    expect('reason' in result && result.reason).toBe('command-timeout')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('rejects a repository mapping whose URL contradicts its provider locator', async () => {
    for (const fixture of [
      { nameWithOwner: 'owner/repo', url: 'https://github.example.com/other/repo' },
      { nameWithOwner: 'owner/repo', url: 'https://user:secret@github.example.com/owner/repo' },
      { nameWithOwner: 'owner/repo', url: 'https://github.example.com/owner/repo?view=files' },
      {
        nameWithOwner: 'owner/repo/extra',
        url: 'https://github.example.com/owner/repo/extra',
      },
    ]) {
      const result = await observeGithubRepositoryMapping(
        'repo_fixture' as RepositoryId,
        'github.example.com',
        {
          run: async () => completed(JSON.stringify({ id: 'R_stable', ...fixture })),
          objects: new MemoryObjects(),
          now: () => new Date('2026-09-05T01:00:00Z'),
        },
      )
      expect('reason' in result && result.reason).toBe('invalid-response')
    }
  })

  test('keeps deleted fork and ref diffs reviewable while narrowing association facts', async () => {
    const deletedForkFixture = metadata({ headRepositoryId: null })
    const deletedFork = await observerFor([
      completed(deletedForkFixture),
      completed('diff'),
      completed(deletedForkFixture),
    ]).observer.observe(ref)
    expect(deletedFork.availability).toBe('available')
    if (deletedFork.availability === 'available') {
      expect(deletedFork.completeness).toBe('partial')
      expect(deletedFork.head.sha).toBe(sha('3'))
      expect(deletedFork.head.repositoryKey).toBeUndefined()
      expect(
        deletedFork.limitations.some(item => item.code === 'incomplete-pull-request-refs'),
      ).toBe(true)
    }

    const deletedRefFixture = metadata({ headRepositoryId: null, headRef: null, headSha: null })
    const deletedRef = await observerFor([
      completed(deletedRefFixture),
      completed('diff'),
      completed(deletedRefFixture),
    ]).observer.observe(ref)
    expect(deletedRef.availability).toBe('available')
    if (deletedRef.availability === 'available') {
      expect(deletedRef.completeness).toBe('partial')
      expect(deletedRef.head.sha).toBeUndefined()
      expect(deletedRef.diff.role).toBe('pull-request-diff')
    }
  })

  test('paginates with <=100-item pages and preserves capped commit data as partial', async () => {
    const page1 = metadata({ commits: [sha('1'), sha('2')], hasNextPage: true, cursor: 'cursor-1' })
    const firstHundred = Array.from({ length: 100 }, (_, index) =>
      index.toString(16).padStart(40, '0'),
    )
    const fullPage = metadata({ commits: firstHundred, hasNextPage: true, cursor: 'cursor-1' })
    const page2 = metadata({ commits: [sha('3')] })
    const exact = observerFor(
      [
        completed(fullPage),
        completed(page2),
        completed('diff'),
        completed(fullPage),
        completed(page2),
      ],
      { maxCommits: 101 },
    )
    const observed = await exact.observer.observe(ref)
    expect(observed.availability === 'available' && observed.commits.length).toBe(101)
    expect(observed.availability === 'available' && observed.commits.at(-1)).toBe(sha('3'))
    expect(exact.calls[0]).toContain('limit=100')
    expect(exact.calls[1]).toContain('cursor=cursor-1')
    const partial = await observerFor([completed(page1), completed('diff'), completed(page1)], {
      maxCommits: 2,
    }).observer.observe(ref)
    expect(partial.availability).toBe('available')
    expect(partial.availability === 'available' && partial.completeness).toBe('partial')
    expect(partial.availability === 'available' && partial.commitMembership).toBe('prefix')
    const oversizedPage = await observerFor(
      [completed(metadata({ commits: [sha('1'), sha('3')] }))],
      { maxCommits: 1 },
    ).observer.observe(ref)
    expect(oversizedPage.availability === 'unavailable' && oversizedPage.reason).toBe(
      'invalid-response',
    )
    const tinyFixture = metadata({ commits: [sha('3')], hasNextPage: true, cursor: 'next' })
    const tinyPage = await observerFor(
      [completed(tinyFixture), completed('diff'), completed(tinyFixture)],
      { maxCommitPages: 1 },
    ).observer.observe(ref)
    expect(tinyPage.availability === 'available' && tinyPage.completeness).toBe('partial')
  })

  test('bounds aggregate bytes and wall time across the complete observation', async () => {
    const bytesBound = await new GithubPrObserver({
      run: async () => completed(metadata()),
      objects: new MemoryObjects(),
      maxGhBytes: 64,
    }).observe(ref)
    expect(bytesBound.availability === 'unavailable' && bytesBound.reason).toBe('output-limit')

    const timeBound = await new GithubPrObserver({
      run: async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
        return completed(metadata())
      },
      objects: new MemoryObjects(),
      maxAcquisitionDurationMs: 5,
    }).observe(ref)
    expect(timeBound.availability === 'unavailable' && timeBound.reason).toBe('command-timeout')
  })

  test('bounds metadata evidence storage within the acquisition deadline', async () => {
    const started = Date.now()
    const result = await new GithubPrObserver({
      run: async () => completed(metadata()),
      objects: {
        put: async () => new Promise<ObjectRef>(() => {}),
      },
      maxAcquisitionDurationMs: 5,
      now: () => new Date('2026-09-05T01:00:00Z'),
    }).observe(ref)

    expect(result.availability === 'unavailable' && result.reason).toBe('command-timeout')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('bounds diff evidence storage within the acquisition deadline', async () => {
    let puts = 0
    const started = Date.now()
    const result = await new GithubPrObserver({
      run: async args => completed(args[0] === 'pr' ? 'diff' : metadata()),
      objects: {
        put: async (bytes, objectMetadata) => {
          puts += 1
          if (puts === 2) return new Promise<ObjectRef>(() => {})
          return new MemoryObjects().put(bytes, objectMetadata)
        },
      },
      maxAcquisitionDurationMs: 10,
      now: () => new Date('2026-09-05T01:00:00Z'),
    }).observe(ref)

    expect(result.availability === 'unavailable' && result.reason).toBe('command-timeout')
    expect(puts).toBe(2)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('rejects mutation, GraphQL errors, invalid timestamps, and non-progress pages', async () => {
    const moved = await observerFor([
      completed(metadata()),
      completed('diff'),
      completed(metadata({ headSha: sha('4'), commits: [sha('2'), sha('4')] })),
    ]).observer.observe(ref)
    expect(moved.availability === 'unavailable' && moved.reason).toBe('observation-changed')
    expect('head' in moved).toBe(false)
    for (const fixture of [
      metadata({ errors: [{ message: 'partial' }] }),
      JSON.stringify({ errors: { message: 'wrong shape' }, data: {} }),
      metadata({ url: 'https://evil.example/owner/repo/pull/42' }),
      metadata({ url: 'https://github.example.com/other/repo/pull/42' }),
      metadata({ url: 'https://github.example.com/owner/repo/pull/41' }),
      metadata({ url: 'https://user:secret@github.example.com/owner/repo/pull/42' }),
      metadata({ url: 'https://github.example.com/owner/repo/pull/42?view=files' }),
      metadata({ repositoryUrl: 'https://github.example.com/other/repo' }),
      metadata({ headRepositoryUrl: 'https://github.example.com/other/repo' }),
      metadata({
        repositoryName: 'owner/repo/extra',
        repositoryUrl: 'https://github.example.com/owner/repo/extra',
      }),
      metadata({
        headRepositoryName: 'owner/repo/extra',
        headRepositoryUrl: 'https://github.example.com/owner/repo/extra',
      }),
      metadata({ updatedAt: '2026-02-30T00:00:00Z' }),
      metadata({ state: 'CLOSED', mergedAt: '2026-02-30T00:00:00Z' }),
      metadata({ state: 'CLOSED', mergedAt: '2026-09-05T00:00:00Z' }),
      metadata({ commits: [sha('2')] }),
      metadata({ commits: [], hasNextPage: true, cursor: 'same' }),
    ]) {
      const result = await observerFor([completed(fixture), completed(fixture)]).observer.observe(
        ref,
      )
      expect(result.availability).toBe('unavailable')
    }
    const badManifest = new GithubPrObserver({
      run: async args => completed(args[0] === 'pr' ? 'diff' : metadata()),
      objects: new MemoryObjects(),
      captureCodeManifest: async () => ({
        algorithm: 'sha256',
        sha256: 'f'.repeat(64),
        bytes: 1,
        mediaType: 'text/plain',
        role: 'wrong',
      }),
      now: () => new Date('2026-09-05T01:00:00Z'),
    })
    const rejectedManifest = await badManifest.observe(ref)
    expect(rejectedManifest.availability).toBe('available')
    expect(
      rejectedManifest.availability === 'available' &&
        rejectedManifest.limitations.some(item => item.code === 'unavailable-pull-request-code'),
    ).toBe(true)

    let aborted = false
    const hangingManifest = new GithubPrObserver({
      run: async args => completed(args[0] === 'pr' ? 'diff' : metadata()),
      objects: new MemoryObjects(),
      maxAcquisitionDurationMs: 5,
      captureCodeManifest: async ({ signal }) =>
        new Promise(resolve => {
          signal.addEventListener('abort', () => {
            aborted = true
            resolve(undefined)
          })
        }),
      now: () => new Date('2026-09-05T01:00:00Z'),
    })
    const timedOutManifest = await hangingManifest.observe(ref)
    expect(timedOutManifest.availability).toBe('available')
    expect(aborted).toBe(true)
  })

  test('files repository-identity races under the first stable base identity', async () => {
    const firstKey = githubRepositoryKey(ref.hostname, 'R_base')
    const firstPage = metadata({
      repositoryId: 'R_base',
      commits: [sha('2')],
      hasNextPage: true,
      cursor: 'next',
    })
    const changedPage = metadata({ repositoryId: 'R_other', commits: [sha('3')] })
    const betweenPages = await observerFor([completed(firstPage), completed(changedPage)], {
      maxCommits: 2,
      maxCommitPages: 2,
    }).observer.observe(ref)
    expect(betweenPages.availability === 'unavailable' && betweenPages.reason).toBe(
      'observation-changed',
    )
    expect(betweenPages.availability === 'unavailable' && betweenPages.record?.repositoryKey).toBe(
      firstKey,
    )

    const firstRead = metadata({ repositoryId: 'R_base' })
    const changedRead = metadata({ repositoryId: 'R_other' })
    const betweenReads = await observerFor([
      completed(firstRead),
      completed('diff'),
      completed(changedRead),
    ]).observer.observe(ref)
    expect(betweenReads.availability === 'unavailable' && betweenReads.reason).toBe(
      'observation-changed',
    )
    expect(betweenReads.availability === 'unavailable' && betweenReads.record?.repositoryKey).toBe(
      firstKey,
    )
  })

  test('types optional-gh failures without exact fields', async () => {
    const cases: Array<[GhCommandResult, PullRequestUnavailableReason]> = [
      [{ kind: 'missing', stdout: new Uint8Array(), stderr: new Uint8Array() }, 'gh-missing'],
      [
        {
          kind: 'completed',
          exitCode: 1,
          stdout: new Uint8Array(),
          stderr: Buffer.from('login required'),
        },
        'authentication-required',
      ],
      [
        {
          kind: 'completed',
          exitCode: 1,
          stdout: new Uint8Array(),
          stderr: Buffer.from('not found'),
        },
        'not-found',
      ],
      [{ kind: 'timeout', stdout: new Uint8Array(), stderr: new Uint8Array() }, 'command-timeout'],
      [
        { kind: 'output-limit', stdout: new Uint8Array(), stderr: new Uint8Array() },
        'output-limit',
      ],
    ]
    for (const [failure, reason] of cases) {
      const result = await observerFor([failure]).observer.observe(ref)
      expect(result.availability === 'unavailable' && result.reason).toBe(reason)
      expect('head' in result).toBe(false)
      expect(result.availability === 'unavailable' && result.record).toBeUndefined()
    }
    const afterIdentity = await observerFor([
      completed(metadata()),
      { kind: 'timeout', stdout: new Uint8Array(), stderr: new Uint8Array() },
    ]).observer.observe(ref)
    expect(
      afterIdentity.availability === 'unavailable' && afterIdentity.record?.repositoryKey,
    ).toBe(githubRepositoryKey(ref.hostname, 'R_base'))
  })

  test('freezes closed, merged, and reopened as separate observations', async () => {
    for (const [fixture, expected] of [
      [metadata({ state: 'CLOSED' }), 'closed'],
      [metadata({ state: 'CLOSED', merged: true }), 'merged'],
      [metadata({ state: 'OPEN', updatedAt: '2026-09-05T02:00:00Z' }), 'open'],
    ] as const) {
      const result = await observerFor([
        completed(fixture),
        completed('diff'),
        completed(fixture),
      ]).observer.observe(ref)
      expect(result.availability === 'available' && result.state).toBe(expected)
    }
  })

  test('bounds real child output and waits for timeout termination', async () => {
    const oversized = await runBoundedGh([], 64, 5_000, 'yes')
    expect([oversized.kind, oversized.stdout.byteLength]).toEqual(['output-limit', 64])
    const started = Date.now()
    expect((await runBoundedGh(['10'], 64, 25, 'sleep')).kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('keeps acquisition deadlines alive in a real child process', async () => {
    for (const mode of ['pr-store', 'mapping-store', 'capture']) {
      const child = Bun.spawn(['bun', '/workspace/packages/github/test/deadline-child.ts', mode], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      let watchdog: ReturnType<typeof setTimeout> | undefined
      try {
        const exitCode = await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(() => {
              child.kill('SIGKILL')
              reject(new Error(`deadline child hung in ${mode}`))
            }, 1_000)
          }),
        ])
        const stdout = await new Response(child.stdout).text()
        expect(exitCode).toBe(0)
        expect(stdout.trim().length).toBeGreaterThan(0)
        const result = JSON.parse(stdout) as { availability: string; reason?: string }
        expect(result.availability).toBe(mode === 'capture' ? 'available' : 'unavailable')
        if (mode !== 'capture') expect(result.reason).toBe('command-timeout')
      } finally {
        if (watchdog !== undefined) clearTimeout(watchdog)
      }
    }
  })
})

const observation = {
  schemaVersion: 1 as const,
  observationId: id('pr-observation'),
  provider: 'github' as const,
  repositoryKey: githubRepositoryKey('github.com', 'R_base'),
  number: 42,
  availability: 'available' as const,
  codeAvailability: 'unavailable' as const,
  completeness: 'complete' as const,
  commitMembership: 'complete' as const,
  state: 'open' as const,
  externalId: 'PR_42',
  hostname: 'github.com',
  url: 'https://github.com/owner/repo/pull/42',
  base: {
    repositoryKey: githubRepositoryKey('github.com', 'R_base'),
    externalId: 'R_base',
    repository: 'owner/repo',
    ref: 'main',
    sha: sha('1'),
  },
  head: {
    repositoryKey: githubRepositoryKey('github.com', 'R_fork'),
    externalId: 'R_fork',
    repository: 'contributor/repo',
    ref: 'feature',
    sha: sha('3'),
  },
  commits: [sha('2'), sha('3')] as [string, ...string[]],
  observedAt: '2026-09-05T01:00:00Z',
  providerUpdatedAt: '2026-09-05T00:00:00Z',
  raw: [
    {
      algorithm: 'sha256' as const,
      sha256: 'a'.repeat(64),
      bytes: 1,
      mediaType: 'application/json',
      role: 'github-pr-metadata',
    },
  ],
  diff: {
    algorithm: 'sha256' as const,
    sha256: 'b'.repeat(64),
    bytes: 1,
    mediaType: 'text/x-diff',
    role: 'pull-request-diff',
  },
  limitations: [
    { code: 'unavailable-pull-request-code' as const, detail: 'Fixture has no code manifest' },
  ],
}

test('persists immutable PR evidence through the sole repository writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-pr-'))
  roots.push(root)
  await mkdir(join(root, '.git'))
  const store = await initializeRepositoryStore(
    root,
    {
      schemaVersion: 1,
      format: 'factory-repository',
      minimumReaderVersion: '0.1.0',
      repositoryId: 'repo_fixture',
      createdAt: '2026-09-05T00:00:00Z',
    },
    {},
  )
  const objects: PrObjectStore = {
    put: async (bytes, metadata) =>
      store.putObject(
        (async function* () {
          yield bytes
        })(),
        metadata,
      ),
  }
  const fixture = metadata()
  const observed = await new GithubPrObserver({
    run: async args => completed(args[0] === 'pr' ? 'diff' : fixture),
    objects,
    now: () => new Date('2026-09-05T01:00:00Z'),
  }).observe(ref)
  expect(observed.availability).toBe('available')
  if (observed.availability !== 'available') return
  const associations = deriveAssociations({
    pullRequest: observed,
    sessions: [sessionEvidence('session', 'repo_fixture' as RepositoryId, sha('3'))],
    repositoryMappings: [],
    manual: [
      {
        sessionKey: 'manual',
        actor: 'developer',
        reason: 'confirmed',
        observedAt: '2026-09-05T02:00:00Z',
      },
      {
        sessionKey: 'manual-later',
        actor: 'developer',
        reason: 'confirmed later',
        observedAt: '2026-09-05T03:00:00Z',
      },
    ],
  })
  const batches = await persistPullRequestEvidence(store, observed, associations)
  await persistPullRequestEvidence(store, observed, associations)
  expect(batches).toHaveLength(3)
  for (const batch of batches) {
    const members = associations.filter(association =>
      batch.evidence.some(item => item.evidenceId === association.evidenceId),
    )
    expect(verifyAssociationBatch(batch, observed, members)).toBe(true)
  }
  const paths = (await store.readRecords()).records
    .map(record => String(record.path))
    .filter(path => path.startsWith('pull-requests/'))
  expect(paths).toHaveLength(7)
  expect(paths.filter(path => path.includes('/batches/'))).toHaveLength(3)
  expect(paths.filter(path => path.endsWith(`${observed.observationId}.json`))).toHaveLength(1)
  expect((await store.verify()).issues).toEqual([])
})

test('association batches are semantic commit points and retry after every crash prefix', async () => {
  const associations = deriveAssociations({
    pullRequest: observation,
    sessions: [sessionEvidence('session', 'repo_fixture' as RepositoryId, sha('3'))],
    repositoryMappings: [],
    manual: [
      {
        sessionKey: 'manual',
        actor: 'developer',
        reason: 'confirmed',
        observedAt: '2026-09-05T02:00:00Z',
      },
    ],
  })
  for (let failureAt = 1; failureAt <= 5; failureAt += 1) {
    const written = new Map<string, Uint8Array>()
    let calls = 0
    let failAt = failureAt
    const store = {
      createImmutable: async (path: unknown, bytes: Uint8Array) => {
        calls += 1
        if (calls === failAt) throw new Error('injected crash')
        written.set(String(path), bytes)
      },
    } as unknown as RepositoryStore
    await expect(persistPullRequestEvidence(store, observation, associations)).rejects.toThrow(
      'injected crash',
    )
    const committedBeforeRetry = [...written.keys()].filter(path => path.includes('/batches/'))
    expect(committedBeforeRetry.length).toBeLessThanOrEqual(1)
    calls = 0
    failAt = Number.POSITIVE_INFINITY
    const batches = await persistPullRequestEvidence(store, observation, associations)
    expect(batches).toHaveLength(2)
    for (const batch of batches) {
      const members = associations.filter(record =>
        batch.evidence.some(item => item.evidenceId === record.evidenceId),
      )
      expect(verifyAssociationBatch(batch, observation, members)).toBe(true)
    }
  }
})

test('batch verification rejects semantic and public-record tampering before projection', async () => {
  const associations = deriveAssociations({
    pullRequest: observation,
    sessions: [sessionEvidence('session', 'repo_fixture' as RepositoryId, sha('3'))],
    repositoryMappings: [],
  })
  const writes: Array<[unknown, Uint8Array]> = []
  const store = {
    createImmutable: async (path: unknown, bytes: Uint8Array) => {
      writes.push([path, bytes])
    },
  } as unknown as RepositoryStore
  const [batch] = await persistPullRequestEvidence(store, observation, associations)
  expect(batch).toBeDefined()
  if (!batch) return
  expect(verifyAssociationBatch({ ...batch, kind: 'manual' }, observation, associations)).toBe(
    false,
  )
  expect(
    verifyAssociationBatch(
      { ...batch, observedAt: '2026-09-05T02:00:00Z' },
      observation,
      associations,
    ),
  ).toBe(false)
  expect(
    verifyAssociationBatch({ ...batch, sourceObservationIds: [] }, observation, associations),
  ).toBe(false)
  expect(
    verifyAssociationBatch(
      { ...batch, evidence: [...batch.evidence, batch.evidence[0]!] },
      observation,
      [...associations, associations[0]!],
    ),
  ).toBe(false)
  expect(
    verifyAssociationBatch(batch, observation, [
      { ...associations[0]!, pullRequestObservationId: id('pr-observation', '2') },
    ]),
  ).toBe(false)
  expect(
    verifyAssociationBatch(batch, observation, [{ ...associations[0]!, extra: true } as never]),
  ).toBe(false)
  expect(verifyAssociationBatch(batch, { ...observation, number: 77 }, associations)).toBe(false)

  const noWrites: Array<unknown> = []
  const invalidStore = {
    createImmutable: async (path: unknown) => {
      noWrites.push(path)
    },
  } as unknown as RepositoryStore
  await expect(
    persistPullRequestEvidence(invalidStore, observation, associations, { policyVersion: '' }),
  ).rejects.toThrow()
  expect(noWrites).toEqual([])
})
