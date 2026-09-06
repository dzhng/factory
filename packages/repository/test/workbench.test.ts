import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canonicalJson,
  decisionAssertionFingerprint,
  makeOwnedPath,
  objectOwnedPath,
  reviewSubjectCoverageId,
  type CoverageAction,
  type DecisionAction,
  type RecordId,
} from '../../contract/src/index'
import {
  writerChoice,
  emptyAuditSummary,
  summarySubmissions,
} from '../../test-harness/src/choice-fixtures'
import {
  ImmutableRecordConflictError,
  initializeRepositoryStore,
  openRepositoryStore,
  snapshotPreparedObject,
  type RepositoryStore,
  type ImmutableGroupRecord,
  type ReviewPublicationAuthority,
} from '../src/index'

if (process.env.FACTORY_DOCKER_TEST !== '1') {
  throw new Error('repository workbench must run in the project Docker test environment')
}

const roots: string[] = []
async function publishFixtureObject(
  store: RepositoryStore,
  source: AsyncIterable<Uint8Array>,
  metadata = { mediaType: 'text/plain', role: 'test-evidence' },
) {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return await store.putObject(
    (await store.preparePublication()).prepareObject(Buffer.concat(chunks), metadata),
  )
}
async function publishFixtureRecord(
  store: RepositoryStore,
  path: ImmutableGroupRecord['path'],
  bytes: Uint8Array,
) {
  return await store.createImmutable((await store.preparePublication()).prepareRecord(path, bytes))
}
async function publishFixtureGroup(
  store: RepositoryStore,
  records: readonly ImmutableGroupRecord[],
  commitPath: ImmutableGroupRecord['path'],
) {
  const context = await store.preparePublication()
  return await store.publishImmutableGroup(
    records.map(record => context.prepareRecord(record.path, record.bytes)),
    commitPath,
  )
}
async function publishFixtureReview(
  store: RepositoryStore,
  authority: ReviewPublicationAuthority,
  records: readonly ImmutableGroupRecord[],
  commitPath: ImmutableGroupRecord['path'],
) {
  const context = await store.preparePublication()
  return await store.publishReview(
    authority,
    records.map(record => context.prepareRecord(record.path, record.bytes)),
    commitPath,
  )
}
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

test('refuses sensitive configuration before creating any initialization prefix', async () => {
  const root = await fixtureRoot()
  await mkdir(join(root, 'ignored', 'nested'), { recursive: true })
  await writeFile(join(root, '.gitignore'), 'ignored/\n')
  await writeFile(join(root, 'ignored', 'nested', '.env.local'), 'MODEL=synthetic-model-secret\n')
  await expect(
    initializeRepositoryStore(root, manifest, {
      reviewer: { provider: 'codex', model: 'synthetic-model-secret' },
    }),
  ).rejects.toThrow('unsupported-content')
  await expect(lstat(join(root, '.factory'))).rejects.toThrow()
})

test('checks the complete resulting config and preserves its bytes on refusal', async () => {
  const root = await fixtureRoot()
  const store = await initializeRepositoryStore(root, manifest, {
    canonicalBranch: 'main',
    extension: { 'synthetic-extension-key': ['ordinary'] },
  })
  const path = join(root, '.factory', 'config.json')
  const before = await readFile(path, 'utf8')
  await writeFile(join(root, '.env'), 'NAME=synthetic-extension-key\n')
  await expect(store.updateConfig({ automaticReview: true })).rejects.toThrow('unsupported-content')
  expect(await readFile(path, 'utf8')).toBe(before)
})

test('refuses sensitive nested config values and labels without redirecting settings', async () => {
  const root = await fixtureRoot()
  const store = await initializeRepositoryStore(root, manifest, { canonicalBranch: 'main' })
  const path = join(root, '.factory', 'config.json')
  const before = await readFile(path, 'utf8')
  await writeFile(join(root, '.env'), 'BRANCH=synthetic-branch-secret\nSHORT_TOKEN=xy\n')
  for (const change of [
    { canonicalBranch: 'synthetic-branch-secret' },
    { reviewer: { provider: 'codex' as const, model: 'xy' } },
    { reviewLimits: { extension: [{ detail: 'xy' }] } },
    { reviewLimits: { extension: { api_key: 'synthetic-inline-credential' } } },
  ]) {
    await expect(store.updateConfig(change)).rejects.toThrow('unsupported-content')
    expect(await readFile(path, 'utf8')).toBe(before)
  }
})

test('discovery failure leaves config initialization and updates untouched', async () => {
  const root = await fixtureRoot()
  await writeFile(join(root, '.env'), 'INVALID ASSIGNMENT\n')
  await expect(initializeRepositoryStore(root, manifest, {})).rejects.toThrow('invalid-env')
  await expect(lstat(join(root, '.factory'))).rejects.toThrow()
  await writeFile(join(root, '.env'), 'ORDINARY=unrelated-value\n')
  const store = await initializeRepositoryStore(root, manifest, { canonicalBranch: 'main' })
  const before = await readFile(join(root, '.factory', 'config.json'), 'utf8')
  await writeFile(join(root, '.env'), 'INVALID ASSIGNMENT\n')
  await expect(store.updateConfig({ automaticReview: true })).rejects.toThrow('invalid-env')
  expect(await readFile(join(root, '.factory', 'config.json'), 'utf8')).toBe(before)
})

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

test('publication admission discovers secrets before CAS identity and refuses forged capabilities', async () => {
  const root = await fixtureRoot()
  const store = await initializeRepositoryStore(root, manifest, {})
  await writeFile(join(root, '.env'), 'API_TOKEN=publication-secret-123\n')
  const preparation = await store.preparePublication()
  const object = preparation.prepareObject(Buffer.from('before publication-secret-123 after'), {
    mediaType: 'text/plain',
    role: 'test-evidence',
  })
  const reference = await store.putObject(object)
  expect(Buffer.from(await store.getObject(reference)).toString()).toBe('before [REDACTED] after')
  await expect(store.putObject({ ...object } as typeof object)).rejects.toThrow('prepared')
})

test('publication admission preserves typed hashes but rejects the same value as review prose', async () => {
  const root = await fixtureRoot()
  const store = await initializeRepositoryStore(root, manifest, {})
  const hash = 'a'.repeat(64)
  await writeFile(join(root, '.env'), `API_TOKEN=${hash}\n`)
  const preparation = await store.preparePublication()
  const graph = reviewRecords(recordId('review'))
  const manifestRecord = graph.records.at(-1)!
  await store.createImmutable(preparation.prepareRecord(manifestRecord.path, manifestRecord.bytes))
  expect(Buffer.from(await store.readImmutable(manifestRecord.path)).toString()).toContain(hash)
  const value = JSON.parse(Buffer.from(manifestRecord.bytes).toString())
  value.reviewer.model = hash
  expect(() =>
    preparation.prepareRecord(manifestRecord.path, Buffer.from(canonicalJson(value))),
  ).toThrow('unprocessed')
  const submissionPath = graph.records[0]!.path
  const submission = { kind: 'choice', choice: { ...writerChoice, assertion: { sha256: hash } } }
  expect(() =>
    preparation.prepareRecord(submissionPath, Buffer.from(canonicalJson(submission))),
  ).toThrow()
})

test('publication admission owns bytes independently of Buffer input and snapshots', async () => {
  const root = await fixtureRoot()
  const store = await initializeRepositoryStore(root, manifest, {})
  const preparation = await store.preparePublication()
  const capability = preparation.prepareObject(Buffer.from('safe'), {
    mediaType: 'text/plain',
    role: 'test',
  })
  snapshotPreparedObject(capability).bytes[0] = 88
  const reference = await store.putObject(capability)
  expect(Buffer.from(await store.getObject(reference)).toString()).toBe('safe')
  const path = makeOwnedPath('review-triggers', [`${trigger.triggerId}.json`])
  const bytes = Buffer.from(canonicalJson(trigger))
  const record = preparation.prepareRecord(path, bytes)
  bytes.fill(88)
  await store.createImmutable(record)
  expect(Buffer.from(await store.readImmutable(path)).toString()).toBe(canonicalJson(trigger))
})

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
        path: makeOwnedPath('reviews', [...root, 'submissions.jsonl']),
        bytes: new TextEncoder().encode(
          disposition === 'failed' ? '' : summarySubmissions(writerChoice.evidence),
        ),
      },
      ...(disposition === 'failed'
        ? []
        : [
            {
              path: makeOwnedPath('reviews', [...root, 'ledger.json']),
              bytes: new TextEncoder().encode(
                canonicalJson({
                  schemaVersion: 1,
                  reviewId: id,
                  entries: [],
                  summary: emptyAuditSummary(writerChoice.evidence),
                }),
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
    const bytes = new TextEncoder().encode('exact prepared UTF-8 bytes ü')
    const refs = await Promise.all([
      publishFixtureObject(
        store,
        (async function* () {
          yield bytes.subarray(0, 4)
          yield bytes.subarray(4)
        })(),
      ),
      publishFixtureObject(
        store,
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
      publishFixtureRecord(store, path, record),
      publishFixtureRecord(store, path, record),
    ])
    expect(created[0]).toEqual(created[1])
    await expect(
      publishFixtureRecord(
        store,
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
    await writeFile(join(root, '.factory', 'foreign.txt'), 'preserved but not Factory-owned\n')
    await writeFile(join(root, '.factory', 'sessions-old'), 'prefix collision remains foreign\n')
    await rm(join(root, '.git', 'factory-runtime'), { recursive: true, force: true })

    const opened = await openRepositoryStore(root)
    const verification = await opened.verify()
    expect(verification.issues).toEqual([])
    expect(verification.ownedStorageBytes).toBe(
      (await lstat(join(root, '.factory', 'manifest.json'))).size +
        (await lstat(join(root, '.factory', 'config.json'))).size,
    )
    expect((await initialized.verify()).issues).toEqual([])
    await expect(lstat(join(root, '.git', 'factory-runtime'))).rejects.toThrow()
  })

  test('counts oversized owned records while excluding preserved foreign files', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const baseline = (await store.verify()).ownedStorageBytes
    const oversizedBytes = 4 * 1024 * 1024 + 1
    await mkdir(join(root, '.factory', 'sessions', 'corrupt'), { recursive: true })
    await writeFile(
      join(root, '.factory', 'sessions', 'corrupt', 'oversized.json'),
      Buffer.alloc(oversizedBytes),
    )
    await writeFile(join(root, '.factory', 'foreign-large.bin'), Buffer.alloc(1024))

    const verification = await store.verify()
    expect(verification.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-structured-record' }),
    )
    expect(verification.ownedStorageBytes).toBe(baseline + oversizedBytes)
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
    await writeFile(join(root, '.env'), 'INVALID ASSIGNMENT\n')
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
      publishFixtureObject(
        store,
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

  test('rejects projections when an owned record root is not an ordinary directory', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const sessions = join(root, '.factory', 'sessions')
    // A missing area is valid, but an existing replacement must not erase its
    // records from an apparently successful projection.
    expect((await store.readRecords()).records).toEqual([])
    await writeFile(sessions, 'not a record directory')
    await expect(store.readRecords()).rejects.toThrow('owned record root')
    await unlink(sessions)
    await symlink('decisions', sessions)
    await expect(store.readRecords()).rejects.toThrow('owned record root')
  })

  test('verification reports an ordinary file replacing an owned root without counting foreign files', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const baseline = (await store.verify()).ownedStorageBytes
    const content = 'corrupt owned root'
    await writeFile(join(root, '.factory', 'sessions'), content)
    await writeFile(join(root, '.factory', 'foreign-notes'), 'preserve me')
    const result = await store.verify()
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'invalid-structured-record', path: 'sessions' }),
    ])
    expect(result.ownedStorageBytes).toBe(baseline + Buffer.byteLength(content))
    expect(await readFile(join(root, '.factory', 'foreign-notes'), 'utf8')).toBe('preserve me')
  })

  test('verification reports special owned roots without opening them or foreign special files', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const baseline = (await store.verify()).ownedStorageBytes
    const owned = join(root, '.factory', 'decisions')
    const foreign = join(root, '.factory', 'foreign-pipe')
    const child = Bun.spawn(['mkfifo', owned, foreign], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(0)
    await expect(store.readRecords()).rejects.toThrow('owned record root')
    const result = await store.verify()
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'invalid-structured-record', path: 'decisions' }),
    ])
    expect(result.ownedStorageBytes).toBe(baseline)
    expect((await lstat(foreign)).isFIFO()).toBe(true)
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
      publishFixtureRecord(
        store,
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
      publishFixtureObject(
        limited,
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
    const ref = await publishFixtureObject(
      store,
      (async function* () {
        yield new TextEncoder().encode('raw')
      })(),
    )
    await writeFile(join(root, '.factory', objectOwnedPath(ref.sha256)), 'bad')
    expect((await store.verify()).issues).toContainEqual(
      expect.objectContaining({ code: 'object-digest-mismatch' }),
    )

    await expect(
      publishFixtureRecord(
        store,
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
    const ref = await publishFixtureObject(
      store,
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
    const ref = await publishFixtureObject(
      store,
      (async function* () {
        yield new TextEncoder().encode('raw lifecycle event')
      })(),
    )
    await publishFixtureRecord(
      store,
      makeOwnedPath('sessions', ['codex', 'session_01', 'lifecycle', `${recordId('event')}.json`]),
      new TextEncoder().encode(
        canonicalJson({
          schemaVersion: 1,
          eventId: recordId('event'),
          sessionKey: 'session_01',
          providerEvent: 'SessionStart',
          observedAt: manifest.createdAt,
          evidence: ref,
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
    const evidence = await publishFixtureObject(
      store,
      (async function* () {
        yield new TextEncoder().encode('cited evidence')
      })(),
    )
    await publishFixtureRecord(
      store,
      makeOwnedPath('decisions', ['observations', `${recordId('decision')}.json`]),
      new TextEncoder().encode(
        canonicalJson({
          schemaVersion: 1,
          observationId: recordId('decision'),
          reviewId: recordId('review'),
          reviewEntryId: recordId('entry'),
          ...writerChoice,
          choiceKey: 'fixture.object-shaped-assertion',
          evidence: [{ object: evidence }],
          effect: 'assert',
          assertion: {
            algorithm: 'sha256',
            sha256: 'f'.repeat(64),
            bytes: 99,
            mediaType: 'incidental',
            role: 'not-authority',
          },
          assertionFingerprint: decisionAssertionFingerprint({
            effect: 'assert',
            assertion: {
              algorithm: 'sha256',
              sha256: 'f'.repeat(64),
              bytes: 99,
              mediaType: 'incidental',
              role: 'not-authority',
            },
          }),
          headline: 'Object-shaped assertion data remains ordinary JSON',
          source: { kind: 'workspace', branch: 'main', exactSnapshot: true },
          confidence: 'high',
          observedAt: manifest.createdAt,
        }),
      ),
    )
    expect((await store.verify()).issues).toEqual([])
  })

  test('appends a decision action once against exact decision-record authority', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, { canonicalBranch: 'main' })
    const assertion = { owner: 'repository' }
    const observation = {
      ...writerChoice,
      schemaVersion: 1 as const,
      observationId: recordId('decision'),
      reviewId: recordId('review'),
      reviewEntryId: recordId('entry'),
      choiceKey: 'repository.writer',
      effect: 'assert' as const,
      assertion,
      assertionFingerprint: decisionAssertionFingerprint({ effect: 'assert', assertion }),
      headline: 'Repository owns durable writes',
      source: { kind: 'workspace' as const, branch: 'main', exactSnapshot: true },
      confidence: 'high' as const,
      observedAt: manifest.createdAt,
    }
    const observationPath = makeOwnedPath('decisions', [
      'observations',
      `${observation.observationId}.json`,
    ])
    const observationBytes = new TextEncoder().encode(canonicalJson(observation))
    await publishFixtureRecord(store, observationPath, observationBytes)
    const authority = {
      canonicalBranch: 'main',
      records: [
        {
          path: observationPath,
          sha256: createHash('sha256').update(observationBytes).digest('hex'),
        },
      ],
    }
    const action: DecisionAction = {
      schemaVersion: 1,
      actionId: recordId('action'),
      previousActionId: null,
      kind: 'confirm',
      targetObservationId: observation.observationId,
      actor: { kind: 'human' },
      expectedStateFingerprint: 'a'.repeat(64),
      createdAt: manifest.createdAt,
    }
    const first = await store.createDecisionAction(action, authority)
    const retry = await store.createDecisionAction(
      { ...action, createdAt: '2026-09-05T00:00:01Z' },
      { canonicalBranch: 'main', records: [] },
    )
    expect(retry).toEqual(first)

    await expect(
      store.createDecisionAction({ ...action, actionId: recordId('other-action') }, authority),
    ).rejects.toThrow('decision authority changed before append')
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

    await publishFixtureGroup(store, records, commitPath)
    await publishFixtureGroup(store, records, commitPath)
    const snapshot = await store.readRecords()
    expect(snapshot.config).toEqual({})
    expect(snapshot.records.map(record => record.path)).toEqual([firstPath, commitPath])
  })

  test('publishes exact review groups idempotently and isolates each review root', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const complete = reviewRecords(recordId('review'))
    await Promise.all([
      publishFixtureGroup(store, complete.records, complete.manifestPath),
      publishFixtureGroup(store, complete.records, complete.manifestPath),
    ])
    const failed = reviewRecords(`review_${'0'.repeat(25)}1`, 'failed')
    await publishFixtureGroup(store, failed.records, failed.manifestPath)
    expect(await store.readImmutable(complete.manifestPath)).toEqual(complete.records.at(-1)!.bytes)
    expect(await store.readImmutable(failed.manifestPath)).toEqual(failed.records.at(-1)!.bytes)

    await expect(
      publishFixtureGroup(store, [...complete.records, failed.records[0]!], complete.manifestPath),
    ).rejects.toThrow('only its exact manifest, response, and ledger')
    const conflicting = complete.records.map(record =>
      record.path.endsWith('submissions.jsonl')
        ? {
            ...record,
            bytes: new TextEncoder().encode(
              summarySubmissions(writerChoice.evidence, 'Different cited review scope'),
            ),
          }
        : record,
    )
    await expect(
      publishFixtureGroup(store, conflicting, complete.manifestPath),
    ).rejects.toBeInstanceOf(ImmutableRecordConflictError)
  })

  test('verifies review repository authority atomically before publication', async () => {
    const root = await fixtureRoot()
    const store = await initializeRepositoryStore(root, manifest, {})
    const subjectPath = makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`])
    const subjectBytes = new TextEncoder().encode(canonicalJson(trigger))
    const subjectSha256 = createHash('sha256').update(subjectBytes).digest('hex')
    await publishFixtureGroup(store, [{ path: subjectPath, bytes: subjectBytes }], subjectPath)
    const review = reviewRecords(recordId('review'))
    const authority = {
      repositoryId: manifest.repositoryId,
      subjectPath,
      subjectRecord: canonicalJson(trigger),
      records: [{ path: subjectPath, sha256: subjectSha256 }],
      inventory: [],
      recordObjects: [],
    }

    await expect(
      publishFixtureReview(
        store,
        { ...authority, records: [{ path: subjectPath, sha256: 'f'.repeat(64) }] },
        review.records,
        review.manifestPath,
      ),
    ).rejects.toThrow('failed verification')
    await expect(
      publishFixtureReview(
        store,
        { ...authority, subjectRecord: canonicalJson({ ...trigger, evidenceWatermark: 99 }) },
        review.records,
        review.manifestPath,
      ),
    ).rejects.toThrow('subject differs')
    await expect(
      publishFixtureReview(
        store,
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
    const subjectObject = {
      algorithm: 'sha256' as const,
      sha256: subjectSha256,
      bytes: subjectBytes.byteLength,
      mediaType: 'application/json',
      role: 'review-history-record',
    }
    await publishFixtureReview(
      store,
      { ...authority, recordObjects: [{ path: subjectPath, object: subjectObject }] },
      review.records,
      review.manifestPath,
    )
    expect(await store.readImmutable(review.manifestPath)).toEqual(review.records.at(-1)!.bytes)
    expect(await store.getObject(subjectObject)).toEqual(subjectBytes)
  })
})
