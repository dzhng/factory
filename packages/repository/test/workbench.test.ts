import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canonicalJson,
  makeOwnedPath,
  objectOwnedPath,
  reviewSubjectCoverageId,
  type CoverageAction,
  type RecordId,
} from '../../contract/src/index'
import {
  ImmutableRecordConflictError,
  initializeRepositoryStore,
  openRepositoryStore,
} from '../src/index'

if (process.env.FACTORY_DOCKER_TEST !== '1') {
  throw new Error('repository workbench must run in the project Docker test environment')
}

const roots: string[] = []
const recordId = (prefix: string) => `${prefix}_${'0'.repeat(26)}` as RecordId
async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'factory-repository-'))
  await mkdir(join(root, '.git'))
  roots.push(root)
  return root
}

afterEach(() => {
  roots.length = 0
})

const manifest = {
  schemaVersion: 1 as const,
  format: 'factory-repository' as const,
  minimumReaderVersion: '0.1.0',
  repositoryId: 'repo_01JFACTORY0000000000000000' as const,
  createdAt: '2026-09-04T00:00:00Z',
}

const trigger = {
  schemaVersion: 1 as const,
  triggerId: recordId('trigger'),
  sessionKey: 'session_01',
  turnId: recordId('turn'),
  evidenceWatermark: 1,
  provider: 'codex' as const,
  createdAt: '2026-09-04T00:00:00Z',
  materialization: 'complete' as const,
  limitations: [],
}

function reviewRecords(id: string, disposition: 'complete' | 'failed' = 'complete') {
  const hash = 'a'.repeat(64)
  const root = ['workspace', id]
  const reviewManifest = {
    schemaVersion: 1 as const,
    reviewId: id,
    subject: { kind: 'workspace' as const, repositoryObservationId: recordId('observation') },
    patches: [],
    sessionWatermarks: {},
    coverageTargetWatermarks: {},
    subjectFingerprint: hash,
    subjectAttempt: {
      fingerprint: hash,
      coverageId: reviewSubjectCoverageId(hash, []),
      effect: 'current-included' as const,
      limitations: [],
    },
    evidenceSelections: [],
    inputProblems: [],
    triggerIds: [],
    associationBatchIds: [],
    limitations: [],
    reviewer: { provider: 'codex' as const, model: 'gpt-test', effort: 'high' },
    analyzerVersion: '1',
    promptVersion: '1',
    policyVersion: '1',
    formatVersion: 1 as const,
    bundleSha256: hash,
    containerImageDigest: `sha256:${hash}`,
    providerCliVersion: '1',
    hostPlatform: 'linux/arm64',
    startedAt: manifest.createdAt,
    completedAt: manifest.createdAt,
    disposition,
    ...(disposition === 'failed' ? { failureReason: 'reviewer-output-empty' as const } : {}),
  }
  return {
    manifestPath: makeOwnedPath('reviews', [...root, 'manifest.json']),
    records: [
      {
        path: makeOwnedPath('reviews', [...root, 'response.txt']),
        bytes: new TextEncoder().encode('review response\n'),
      },
      ...(disposition === 'failed'
        ? []
        : [
            {
              path: makeOwnedPath('reviews', [...root, 'ledger.json']),
              bytes: new TextEncoder().encode(
                canonicalJson({ schemaVersion: 1, reviewId: id, entries: [] }),
              ),
            },
          ]),
      {
        path: makeOwnedPath('reviews', [...root, 'manifest.json']),
        bytes: new TextEncoder().encode(canonicalJson(reviewManifest)),
      },
    ],
  }
}

describe('sole repository writer', () => {
  test('converges semantic coverage acceptance on the first real publication time', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, { canonicalBranch: 'main' })
    const semantic: Omit<CoverageAction, 'createdAt'> = {
      schemaVersion: 1,
      actionId: recordId('action'),
      reviewId: recordId('review'),
      acceptedLimitations: ['missing-transcript-range'],
      acceptedTriggerIds: [],
      acceptedProblemIds: [],
      settledWatermarks: { session: 1 },
    }
    const [first, second] = await Promise.all([
      store.createCoverageAction(semantic, () => new Date('2026-09-04T01:00:00Z')),
      store.createCoverageAction(semantic, () => new Date('2026-09-04T02:00:00Z')),
    ])
    expect(first).toEqual(second)
    const saved = JSON.parse(
      await readFile(join(root, '.factory', first.path), 'utf8'),
    ) as CoverageAction
    expect(['2026-09-04T01:00:00.000Z', '2026-09-04T02:00:00.000Z']).toContain(saved.createdAt)
    await expect(
      store.createCoverageAction({ ...semantic, settledWatermarks: { session: 2 } }),
    ).rejects.toBeInstanceOf(ImmutableRecordConflictError)
  })

  test('round-trips objects and converges concurrent identical creation', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, { canonicalBranch: 'main' })
    const bytes = new TextEncoder().encode('exact raw bytes\0\xff')
    const refs = await Promise.all([
      store.putObject(
        (async function* () {
          yield bytes.subarray(0, 4)
          yield bytes.subarray(4)
        })(),
      ),
      store.putObject(
        (async function* () {
          yield bytes
        })(),
      ),
    ])
    expect(refs[0]).toEqual(refs[1])
    expect(await readFile(join(root, '.factory', objectOwnedPath(refs[0]!.sha256)))).toEqual(
      Buffer.from(bytes),
    )

    const path = makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`])
    const record = new TextEncoder().encode(canonicalJson(trigger))
    const created = await Promise.all([
      store.createImmutable(path, record),
      store.createImmutable(path, record),
    ])
    expect(created[0]).toEqual(created[1])
    await expect(
      store.createImmutable(
        path,
        new TextEncoder().encode(canonicalJson({ ...trigger, evidenceWatermark: 2 })),
      ),
    ).rejects.toBeInstanceOf(ImmutableRecordConflictError)
  })

  test('preserves foreign content and unknown config fields byte-for-byte', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {
      canonicalBranch: 'main',
      futurePolicy: { enabled: true },
      reviewer: { provider: 'codex', futureOption: true },
      reviewLimits: { maxSessions: 2, futureLimit: 3 },
    })
    await mkdir(join(root, '.factory', 'skills'))
    await writeFile(join(root, '.factory', 'skills', 'foreign.bin'), new Uint8Array([0, 255, 1]))
    await writeFile(join(root, '.factory', 'foreign.txt'), 'leave me\n')
    await writeFile(join(root, '.factory', 'sessions-old'), 'prefix collision stays foreign\n')

    await Promise.all([
      store.updateConfig({ canonicalBranch: 'trunk' }),
      store.updateConfig({ automaticReview: true }),
    ])

    expect(await readFile(join(root, '.factory', 'skills', 'foreign.bin'))).toEqual(
      Buffer.from([0, 255, 1]),
    )
    expect(await readFile(join(root, '.factory', 'foreign.txt'), 'utf8')).toBe('leave me\n')
    expect(await readFile(join(root, '.factory', 'sessions-old'), 'utf8')).toBe(
      'prefix collision stays foreign\n',
    )
    expect(JSON.parse(await readFile(join(root, '.factory', 'config.json'), 'utf8'))).toMatchObject(
      {
        canonicalBranch: 'trunk',
        automaticReview: true,
        futurePolicy: { enabled: true },
        reviewer: { provider: 'codex', futureOption: true },
        reviewLimits: { maxSessions: 2, futureLimit: 3 },
      },
    )
    expect(await store.readConfig()).toMatchObject({
      canonicalBranch: 'trunk',
      automaticReview: true,
      futurePolicy: { enabled: true },
    })
  })

  test('keeps open and verify read-only when runtime state is absent', async () => {
    const root = await fixtureRoot()
    const initialized = await initializeRepositoryStore(root, manifest, {})
    await rm(join(root, '.git', 'factory-runtime'), { recursive: true, force: true })

    const opened = await openRepositoryStore(root)
    expect((await opened.verify()).issues).toEqual([])
    expect((await initialized.verify()).issues).toEqual([])
    await expect(lstat(join(root, '.git', 'factory-runtime'))).rejects.toThrow()
  })

  test('verifies a non-Git repository opened with an explicit runtime root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-explicit-runtime-'))
    const runtimeRoot = join(root, 'runtime')
    roots.push(root)
    await mkdir(runtimeRoot)

    const store = await initializeRepositoryStore(root, manifest, {}, { runtimeRoot })
    expect((await store.verify()).issues).toEqual([])
  })

  test('keys runtime staging independently for linked worktrees', async () => {
    const common = await mkdtemp(join(tmpdir(), 'factory-common-'))
    const first = await mkdtemp(join(tmpdir(), 'factory-worktree-a-'))
    const second = await mkdtemp(join(tmpdir(), 'factory-worktree-b-'))
    roots.push(common, first, second)
    const firstGit = join(common, 'worktrees', 'a')
    const secondGit = join(common, 'worktrees', 'b')
    await mkdir(firstGit, { recursive: true })
    await mkdir(secondGit, { recursive: true })
    await writeFile(join(firstGit, 'commondir'), '../..\n')
    await writeFile(join(secondGit, 'commondir'), '../..\n')
    await writeFile(join(first, '.git'), `gitdir: ${firstGit}\n`)
    await writeFile(join(second, '.git'), `gitdir: ${secondGit}\n`)

    const firstStore = await initializeRepositoryStore(first, manifest, {})
    const secondStore = await initializeRepositoryStore(second, manifest, {})
    expect(firstStore.stagingRoot).not.toBe(secondStore.stagingRoot)
  })

  test('stops on a too-new manifest before mutating config', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, '.factory'))
    await writeFile(
      join(root, '.factory', 'manifest.json'),
      canonicalJson({ ...manifest, minimumReaderVersion: '9.0.0' }),
    )
    const before = await readFile(join(root, '.factory', 'manifest.json'))
    await expect(openRepositoryStore(root)).rejects.toThrow('requires reader 9.0.0')
    await expect(initializeRepositoryStore(root, manifest, {})).rejects.toThrow(
      'requires reader 9.0.0',
    )
    expect(await readFile(join(root, '.factory', 'manifest.json'))).toEqual(before)
    await expect(readFile(join(root, '.factory', 'config.json'))).rejects.toThrow()
    await expect(lstat(join(root, '.git', 'factory-runtime'))).rejects.toThrow()
  })

  test('rechecks compatibility before every mutation and refuses cross-filesystem staging', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    await writeFile(
      join(root, '.factory', 'manifest.json'),
      canonicalJson({ ...manifest, minimumReaderVersion: '9.0.0' }),
    )
    await expect(
      store.putObject(
        (async function* () {
          yield new TextEncoder().encode('must not publish')
        })(),
      ),
    ).rejects.toThrow('requires reader 9.0.0')
    await expect(readFile(join(root, '.factory', 'objects'))).rejects.toThrow()

    const other = await fixtureRoot()
    await initializeRepositoryStore(other, manifest, {})
    await mkdir('/runtime/factory', { recursive: true })
    await expect(openRepositoryStore(other, { runtimeRoot: '/runtime/factory' })).rejects.toThrow(
      'share one filesystem',
    )
  })

  test('refuses symlinked owned areas, corrupt objects, and oversized input', async () => {
    const root = await fixtureRoot()
    const outside = join(root, 'outside')
    await mkdir(outside)
    const store = await initializeRepositoryStore(root, manifest, {})
    await symlink(outside, join(root, '.factory', 'sessions'))
    await mkdir(join(root, '.factory', 'decisions'))
    await symlink('../decisions', join(root, '.factory', 'decisions', 'cycle'))
    await expect(
      store.createImmutable(
        makeOwnedPath('sessions', ['codex', 'session_01', 'identity.json']),
        new TextEncoder().encode(
          canonicalJson({
            schemaVersion: 1,
            provider: 'codex',
            nativeSessionId: 'native-session-01',
            sessionKey: 'session_01',
            captureGeneration: 1,
            repositoryId: manifest.repositoryId,
            firstObservedAt: manifest.createdAt,
          }),
        ),
      ),
    ).rejects.toThrow('symbolic link')

    const limited = await openRepositoryStore(root, { maxObjectBytes: 3 })
    await expect(
      limited.putObject(
        (async function* () {
          yield new Uint8Array([1, 2, 3, 4])
        })(),
      ),
    ).rejects.toThrow('maximum')
    await mkdir(join(root, '.factory', 'objects', 'sha256', '000'), { recursive: true })
    await writeFile(
      join(root, '.factory', 'objects', 'sha256', '000', '0'.repeat(61)),
      new Uint8Array([1, 2, 3, 4]),
    )
    await mkdir(join(root, '.factory', 'objects', 'sha256', '00'), { recursive: true })
    await writeFile(
      join(root, '.factory', 'objects', 'sha256', '00', '0'.repeat(62)),
      new Uint8Array([1, 2, 3, 4]),
    )
    const verification = await limited.verify()
    expect(verification.issues).toContainEqual(
      expect.objectContaining({ code: 'object-name-invalid' }),
    )
    expect(verification.issues).toContainEqual(
      expect.objectContaining({ code: 'object-oversized' }),
    )
    expect(verification.issues).toContainEqual(
      expect.objectContaining({ code: 'unsafe-symbolic-link', path: 'decisions/cycle' }),
    )
  })

  test('verification detects substituted objects and absolute metadata paths', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const ref = await store.putObject(
      (async function* () {
        yield new TextEncoder().encode('raw')
      })(),
    )
    await writeFile(join(root, '.factory', objectOwnedPath(ref.sha256)), 'bad')
    expect((await store.verify()).issues).toContainEqual(
      expect.objectContaining({ code: 'object-digest-mismatch' }),
    )

    await expect(
      store.createImmutable(
        makeOwnedPath('repository-observations', [`${recordId('observation')}.json`]),
        new TextEncoder().encode(
          canonicalJson({
            schemaVersion: 1,
            observationId: recordId('observation'),
            repositoryId: manifest.repositoryId,
            observedAt: manifest.createdAt,
            completedAt: manifest.createdAt,
            git: { detached: false },
            changedPaths: [],
            worktreeFingerprint: '0'.repeat(64),
            limitations: [],
            startState: '0'.repeat(64),
            endState: '0'.repeat(64),
            checkoutPath: '/home/alice/repo',
          }),
        ),
      ),
    ).rejects.toThrow('unknown fields')
  })

  test('materializes verified objects create-only and refuses a canonical-path symlink', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const ref = await store.putObject(
      (async function* () {
        yield new TextEncoder().encode('bundle evidence')
      })(),
    )
    const source = join(root, '.factory', objectOwnedPath(ref.sha256))
    const bundle = join(root, 'bundle')
    const destination = join(bundle, objectOwnedPath(ref.sha256))
    await mkdir(join(destination, '..'), { recursive: true })
    await symlink(source, destination)

    await expect(store.materializeObjectInventory([ref], bundle)).rejects.toThrow('symbolic link')
    expect((await lstat(destination)).isSymbolicLink()).toBe(true)
  })

  test('verification reports missing references and truncated records as typed issues', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const ref = await store.putObject(
      (async function* () {
        yield new TextEncoder().encode('raw lifecycle event')
      })(),
    )
    await store.createImmutable(
      makeOwnedPath('sessions', ['codex', 'session_01', 'lifecycle', `${recordId('event')}.json`]),
      new TextEncoder().encode(
        canonicalJson({
          schemaVersion: 1,
          eventId: recordId('event'),
          sessionKey: 'session_01',
          providerEvent: 'SessionStart',
          observedAt: manifest.createdAt,
          raw: ref,
        }),
      ),
    )
    await unlink(join(root, '.factory', objectOwnedPath(ref.sha256)))
    await mkdir(join(root, '.factory', 'decisions', 'actions'), { recursive: true })
    await writeFile(join(root, '.factory', 'decisions', 'actions', 'truncated.json'), '{"schema')

    const verification = await store.verify()
    expect(verification.issues).toContainEqual(
      expect.objectContaining({ code: 'referenced-object-missing' }),
    )
    expect(verification.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-structured-record' }),
    )
  })

  test('does not treat provider-parsed or decision-subject data as authoritative object refs', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    await store.createImmutable(
      makeOwnedPath('decisions', ['observations', `${recordId('decision')}.json`]),
      new TextEncoder().encode(
        canonicalJson({
          schemaVersion: 1,
          observationId: recordId('decision'),
          reviewId: recordId('review'),
          reviewEntryId: recordId('entry'),
          subject: {
            algorithm: 'sha256',
            sha256: 'f'.repeat(64),
            bytes: 99,
            mediaType: 'incidental',
            role: 'not-authority',
          },
          summary: 'Object-shaped subject data remains ordinary JSON',
          canonicalBranch: true,
          confidence: 'high',
          observedAt: manifest.createdAt,
        }),
      ),
    )
    expect((await store.verify()).issues).toEqual([])
  })

  test('releases mutation ownership when the locking process dies', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {}, { mutationLockTimeoutMs: 50 })
    const lock = join(store.stagingRoot, 'repository.lock')
    const worker = Bun.spawn(
      [
        'bun',
        '-e',
        `import { withAdvisoryFileLock } from '/workspace/packages/repository/src/confined-writer.ts'; await withAdvisoryFileLock(${JSON.stringify(lock)}, 1000, async () => { console.log('locked'); await new Promise(() => {}) })`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const reader = worker.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked')
    await expect(store.updateConfig({ automaticReview: true })).rejects.toThrow(
      'advisory file lock is unavailable',
    )
    worker.kill(9)
    await worker.exited
    await store.updateConfig({ automaticReview: true })
    expect(
      JSON.parse(await readFile(join(root, '.factory', 'config.json'), 'utf8')),
    ).toHaveProperty('automaticReview', true)
  })

  test('publishes a deterministic immutable group with its commit record last', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const firstPath = makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`])
    const secondId = `trigger_${'0'.repeat(25)}1`
    const commitPath = makeOwnedPath('review-triggers', [`${secondId}.json`])
    const records = [
      { path: firstPath, bytes: new TextEncoder().encode(canonicalJson(trigger)) },
      {
        path: commitPath,
        bytes: new TextEncoder().encode(
          canonicalJson({ ...trigger, triggerId: secondId, evidenceWatermark: 2 }),
        ),
      },
    ]

    await store.publishImmutableGroup(records, commitPath)
    await store.publishImmutableGroup(records, commitPath)
    expect((await store.readRecords()).records.map(record => record.path)).toEqual([
      firstPath,
      commitPath,
    ])
  })

  test('publishes exact review groups idempotently and isolates each review root', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const complete = reviewRecords(recordId('review'))
    await Promise.all([
      store.publishImmutableGroup(complete.records, complete.manifestPath),
      store.publishImmutableGroup(complete.records, complete.manifestPath),
    ])
    const failed = reviewRecords(`review_${'0'.repeat(25)}1`, 'failed')
    await store.publishImmutableGroup(failed.records, failed.manifestPath)
    expect(await store.readImmutable(complete.manifestPath)).toEqual(complete.records.at(-1)!.bytes)
    expect(await store.readImmutable(failed.manifestPath)).toEqual(failed.records.at(-1)!.bytes)

    await expect(
      store.publishImmutableGroup([...complete.records, failed.records[0]!], complete.manifestPath),
    ).rejects.toThrow('only its exact manifest, response, and ledger')
    const conflicting = complete.records.map(record =>
      record.path.endsWith('response.txt')
        ? { ...record, bytes: new TextEncoder().encode('different response\n') }
        : record,
    )
    await expect(
      store.publishImmutableGroup(conflicting, complete.manifestPath),
    ).rejects.toBeInstanceOf(ImmutableRecordConflictError)
  })

  test('verifies review repository authority atomically before publication', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const subjectPath = makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`])
    const subjectBytes = new TextEncoder().encode(canonicalJson(trigger))
    const subjectSha256 = createHash('sha256').update(subjectBytes).digest('hex')
    await store.publishImmutableGroup([{ path: subjectPath, bytes: subjectBytes }], subjectPath)
    const review = reviewRecords(recordId('review'))
    const authority = {
      repositoryId: manifest.repositoryId,
      subjectPath,
      subjectRecord: canonicalJson(trigger),
      records: [{ path: subjectPath, sha256: subjectSha256 }],
      inventory: [],
    }

    await expect(
      store.publishReview(
        { ...authority, records: [{ path: subjectPath, sha256: 'f'.repeat(64) }] },
        review.records,
        review.manifestPath,
      ),
    ).rejects.toThrow('failed verification')
    await expect(
      store.publishReview(
        { ...authority, subjectRecord: canonicalJson({ ...trigger, evidenceWatermark: 99 }) },
        review.records,
        review.manifestPath,
      ),
    ).rejects.toThrow('subject differs')
    await expect(
      store.publishReview(
        {
          ...authority,
          inventory: [
            {
              algorithm: 'sha256',
              sha256: 'e'.repeat(64),
              bytes: 1,
              mediaType: 'text/plain',
              role: 'missing-test-object',
            },
          ],
        },
        review.records,
        review.manifestPath,
      ),
    ).rejects.toThrow()
    await store.publishReview(authority, review.records, review.manifestPath)
    expect(await store.readImmutable(review.manifestPath)).toEqual(review.records.at(-1)!.bytes)
  })
})
