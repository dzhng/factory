import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { canonicalJson, makeOwnedPath } from '@factory/contract'
import { snapshotPreparedRecord } from '@factory/repository/internal/admission'

import {
  JournalCorruptionError,
  inspectRuntimeJournal,
  openRuntimeJournal as openJournal,
  type DurabilityBoundary,
  type MaterializationClaim,
  type RuntimeJournal,
  type RuntimeJournalOptions,
  type RuntimeRecordRef,
} from '../src/index.js'
import { prepareFixtureRecord, turnFixture } from './prepared-fixture'

const openedJournals: RuntimeJournal[] = []
async function openRuntimeJournal(options: RuntimeJournalOptions): Promise<RuntimeJournal> {
  const journal = await openJournal(options)
  openedJournals.push(journal)
  return journal
}
afterEach(async () => {
  await Promise.all(openedJournals.splice(0).map(journal => journal.close()))
})

describe('runtime journal', () => {
  test('refuses a prepared snapshot beyond the caller byte budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-preparation-budget-'))
    const { path, bytes } = turnFixture('codex', 'session', 'stop', 'bounded copy')
    const prepared = await prepareFixtureRecord(root, path, bytes)
    expect(() => snapshotPreparedRecord(prepared, { maximumBytes: bytes.byteLength - 1 })).toThrow(
      'byte bound',
    )
    expect(snapshotPreparedRecord(prepared, { maximumBytes: bytes.byteLength }).bytes).toEqual(
      bytes,
    )
  })

  test('refuses unprepared capture bytes before freezing publication authority', async () => {
    const root = await preparedStopRoot()
    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    const claim = (await journal.claimStop(crashStop)).claim
    const path = makeOwnedPath('sessions', ['codex', 'session', 'turns', 'turn', 'manifest.json'])
    const bytes = new TextEncoder().encode('unprocessed private content')
    await expect(
      Reflect.apply(journal.prepareCapture, journal, [
        { kind: 'stop', claim },
        {
          objects: [],
          records: [{ path, bytes }],
          commitPath: path,
          completion: { path, sha256: createHash('sha256').update(bytes).digest('hex') },
        },
      ]),
    ).rejects.toThrow('prepared')
    expect(await journal.readCapturePreparation({ kind: 'stop', claim })).toBeUndefined()
  })

  test('requires a frozen preparation before retiring a verified Stop', async () => {
    const root = await preparedStopRoot()
    const journal = await openRuntimeJournal({
      testRuntimeRoot: root,
      verifyTurn: turnVerifier(root),
    })
    const claim = (await journal.claimStop(crashStop)).claim
    const turn = await writeTurn(root, 'codex', 'session', 'stop', 'verified turn')
    await expect(journal.complete(claim, turn)).rejects.toThrow('preparation')
    expect((await Array.fromAsync(journal.recover()))[0]!.claim).toEqual(claim)
    await prepareTurn(journal, claim, turn)
    await journal.complete(claim, turn)
    expect((await journal.inventory()).orphaned).toContain(turn.sha256)
  })

  test('refuses a frozen graph mixing preparation from different worktrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-preparation-owner-'))
    const other = await mkdtemp(join(tmpdir(), 'factory-preparation-other-'))
    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    await journal.append({
      ...capture('owner-stop', 'private original'),
      eventKind: 'stop',
      stopId: 'stop-1',
      worktreePath: root,
    })
    const claim = (await journal.claimStop(crashStop)).claim
    const { path, bytes } = turnFixture('codex', 'session', 'stop', 'prepared for another worktree')
    const completion = { path, sha256: createHash('sha256').update(bytes).digest('hex') }
    await expect(
      journal.prepareCapture(
        { kind: 'stop', claim },
        {
          objects: [],
          records: [
            await prepareFixtureRecord(root, path, bytes),
            await prepareFixtureRecord(other, path, bytes),
          ],
          commitPath: path,
          completion,
        },
      ),
    ).rejects.toThrow('different repositories')
    expect(await journal.readCapturePreparation({ kind: 'stop', claim })).toBeUndefined()
    await journal.prepareCapture(
      { kind: 'stop', claim },
      {
        objects: [],
        records: [await prepareFixtureRecord(root, path, bytes)],
        commitPath: path,
        completion,
      },
    )
    const restored = await journal.readCapturePreparation({ kind: 'stop', claim })
    expect(snapshotPreparedRecord(restored!.records[0]!).repositoryRoot).toBe(root)
    expect(snapshotPreparedRecord(restored!.records[0]!).bytes).toEqual(bytes)
  })

  test('recovers preparation transaction death as absent or exact frozen bytes', async () => {
    for (const boundary of [
      'preparation-transaction-staged',
      'preparation-transaction-committed',
    ] as const) {
      const root = await preparedStopRoot()
      const journal = await openRuntimeJournal({ testRuntimeRoot: root })
      const claim = (await journal.claimStop(crashStop)).claim
      const turn = await writeTurn(root, 'codex', 'session', 'stop', 'prepared before crash')
      await killWorker(root, 'prepare', boundary, {
        FACTORY_TEST_CLAIM: JSON.stringify(claim),
        FACTORY_TEST_TURN: JSON.stringify(turn),
      })
      const recovered = await journal.readCapturePreparation({ kind: 'stop', claim })
      if (boundary === 'preparation-transaction-staged') expect(recovered).toBeUndefined()
      else
        expect(snapshotPreparedRecord(recovered!.records[0]!).bytes).toEqual(
          new Uint8Array(await readFile(join(root, '.factory', turn.path))),
        )
      await prepareTurn(journal, claim, turn)
      expect((await journal.readCapturePreparation({ kind: 'stop', claim }))!.completion).toEqual({
        path: turn.path,
        sha256: turn.sha256,
      })
    }
  })

  test('freezes prepared capture bytes before publication and reloads them after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-preparation-'))
    let journal = await openRuntimeJournal({ testRuntimeRoot: root })
    await journal.append({
      ...capture('prepared-stop', 'private original'),
      eventKind: 'stop',
      stopId: 'stop-1',
    })
    const claim = (await journal.claimStop(crashStop)).claim
    const { path, bytes } = turnFixture('codex', 'session', 'turn', 'sanitized prepared bytes')
    const expected = bytes.slice()
    const preparation = {
      objects: [],
      records: [await prepareFixtureRecord(root, path, bytes)],
      commitPath: path,
      completion: { path, sha256: createHash('sha256').update(bytes).digest('hex') },
    }
    await journal.prepareCapture({ kind: 'stop', claim }, preparation)
    bytes.fill(0)
    await journal.close()
    journal = await openRuntimeJournal({ testRuntimeRoot: root })
    const loaded = await journal.readCapturePreparation({ kind: 'stop', claim })
    expect(snapshotPreparedRecord(loaded!.records[0]!).bytes).toEqual(expected)
    await journal.prepareCapture({ kind: 'stop', claim }, loaded!)
    snapshotPreparedRecord(loaded!.records[0]!).bytes.fill(1)
    expect(
      snapshotPreparedRecord(
        (await journal.readCapturePreparation({ kind: 'stop', claim }))!.records[0]!,
      ).bytes,
    ).toEqual(expected)
    expect((await journal.inventory()).referenced).toContain(preparation.completion.sha256)
    expect((await journal.inventory()).orphaned).not.toContain(preparation.completion.sha256)
    await journal.close()
    const { Database } = await import('bun:sqlite')
    const database = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    database.run('UPDATE capture_preparations SET binding=?', ['0'.repeat(64)])
    database.close()
    await expect(openRuntimeJournal({ testRuntimeRoot: root })).rejects.toThrow('preparation')
  })

  test('durably preserves exact raw bytes before acknowledging an event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-journal-'))
    const journal = await openRuntimeJournal({
      testRuntimeRoot: root,
      verifyTurn: turnVerifier(root),
    })
    const raw = new Uint8Array([0, 255, 10, 13, 123, 125])

    const receipt = await journal.append({
      provider: 'codex',
      sessionId: 'native-session',
      generation: 0,
      eventId: 'event-1',
      eventKind: 'turn',
      occurredAt: '2026-09-04T00:00:00Z',
      raw,
    })

    expect(receipt.sequence).toBe(0)
    expect(await journal.readRaw(receipt)).toEqual(raw)
  })

  test('makes exact retries idempotent and rejects identity reuse with different bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-journal-'))
    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    const input = {
      provider: 'claude' as const,
      sessionId: 'session-retry',
      generation: 2,
      eventId: 'event-1',
      eventKind: 'turn' as const,
      occurredAt: '2026-09-04T00:00:00Z',
      raw: new TextEncoder().encode('{"native":"payload"}'),
    }

    const first = await journal.append(input)
    const retried = await journal.append(input)

    expect(retried).toEqual(first)
    await expect(
      journal.append({ ...input, raw: new TextEncoder().encode('changed') }),
    ).rejects.toThrow('different bytes or metadata')
  })

  test('rejects unsupported or oversized metadata before allocating a sequence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-invalid-input-'))
    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    const valid = capture('valid', 'valid')
    const invalid = [
      { ...valid, provider: 'other' },
      { ...valid, eventKind: 'unknown' },
      { ...valid, occurredAt: '2026-09-04T09:00:00+09:00' },
      { ...valid, stopId: 'not-a-stop' },
      { ...valid, sessionId: 'x'.repeat(4097) },
      { ...valid, worktreePath: 'relative/path' },
      { ...valid, worktreePath: '/valid\0hidden' },
      { ...valid, eventId: 'broken\ud800' },
      { ...valid, raw: new Uint8Array(64 * 1024 * 1024 + 1) },
    ]
    for (const input of invalid)
      await expect(
        journal.append(input as Parameters<RuntimeJournal['append']>[0]),
      ).rejects.toBeInstanceOf(TypeError)

    expect((await journal.append(valid)).sequence).toBe(0)
  })

  test('allocates one contiguous order across eight concurrent hook processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-journal-'))
    const writers = Array.from({ length: 8 }, (_, worker) =>
      Bun.spawn(
        [
          'bun',
          new URL('./concurrent-writer.ts', import.meta.url).pathname,
          root,
          String(worker),
          '25',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      ),
    )

    const exits = await Promise.all(writers.map(writer => writer.exited))
    if (exits.some(code => code !== 0)) {
      const errors = await Promise.all(writers.map(writer => new Response(writer.stderr).text()))
      throw new Error(errors.filter(Boolean).join('\n'))
    }

    const reopened = await openRuntimeJournal({ testRuntimeRoot: root })
    expect((await reopened.inventory()).referenced).toHaveLength(200)
  }, 30_000)

  test('locates one Git-common journal from linked-worktree metadata', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'factory-linked-'))
    const common = join(parent, 'common')
    const main = join(parent, 'main')
    const linked = join(parent, 'linked')
    await mkdir(join(common, 'worktrees', 'main'), { recursive: true })
    await mkdir(join(common, 'worktrees', 'linked'), { recursive: true })
    await mkdir(main)
    await mkdir(linked)
    await writeFile(join(main, '.git'), `gitdir: ${join(common, 'worktrees', 'main')}\n`)
    await writeFile(join(linked, '.git'), `gitdir: ${join(common, 'worktrees', 'linked')}\n`)
    await writeFile(join(common, 'worktrees', 'main', 'commondir'), '../..\n')
    await writeFile(join(common, 'worktrees', 'linked', 'commondir'), '../..\n')

    const mainJournal = await openRuntimeJournal({ repositoryRoot: main })
    const linkedJournal = await openRuntimeJournal({ repositoryRoot: linked })
    const receipts = await Promise.all([
      mainJournal.append({ ...capture('main-event', 'main'), worktreePath: main }),
      linkedJournal.append({ ...capture('linked-event', 'linked'), worktreePath: linked }),
    ])

    expect(receipts.map(receipt => receipt.sequence).sort()).toEqual([0, 1])
    expect((await mainJournal.inventory()).referenced).toHaveLength(2)
    expect((await linkedJournal.inventory()).referenced).toHaveLength(2)
  }, 30_000)

  test('inspects an existing Git-common journal without creating or changing runtime state', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'factory-inspect-'))
    const gitDirectory = join(repository, '.git')
    await mkdir(gitDirectory)

    expect(await inspectRuntimeJournal(repository)).toEqual({ state: 'absent', storageBytes: 0 })
    expect(await Bun.file(join(gitDirectory, 'factory-runtime')).exists()).toBe(false)

    const journal = await openRuntimeJournal({ repositoryRoot: repository })
    await journal.append({
      ...capture('pending-stop', 'stop-payload'),
      eventKind: 'stop',
      stopId: 'stop-1',
    })
    await journal.append({ ...capture('pending-end', 'end-payload'), eventKind: 'session-end' })
    const diagnosticId = await journal.recordDiagnostic(new Error('inspection evidence'))
    await journal.close()

    const runtimeRoot = join(gitDirectory, 'factory-runtime')
    const inspection = await inspectRuntimeJournal(repository)
    expect(inspection).toEqual({
      state: 'available',
      pendingStops: 1,
      pendingLifecycle: 1,
      diagnostics: [`${diagnosticId}.txt`],
      diagnosticsTruncated: false,
      storageBytes: expect.any(Number),
    })
    expect(inspection.storageBytes).toBeGreaterThan(0)
    const before = await treeFingerprint(runtimeRoot)
    await inspectRuntimeJournal(repository)
    expect(await treeFingerprint(runtimeRoot)).toEqual(before)
  })

  test('rejects a half-present runtime journal during inspection', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'factory-inspect-incomplete-'))
    const runtimeRoot = join(repository, '.git', 'factory-runtime')
    const journalRoot = join(runtimeRoot, 'journal-v1')
    await mkdir(journalRoot, { recursive: true })
    await chmod(runtimeRoot, 0o700)
    await chmod(journalRoot, 0o700)

    await expect(inspectRuntimeJournal(repository)).rejects.toThrow(
      'Runtime journal database is missing',
    )
  })

  test('rejects unsafe runtime parents and SQLite sidecars during inspection', async () => {
    const symlinkedRepository = await mkdtemp(join(tmpdir(), 'factory-inspect-symlink-'))
    const external = await mkdtemp(join(tmpdir(), 'factory-inspect-external-'))
    await mkdir(join(symlinkedRepository, '.git'))
    await symlink(external, join(symlinkedRepository, '.git', 'factory-runtime'))
    await expect(inspectRuntimeJournal(symlinkedRepository)).rejects.toThrow(
      'Runtime root is not an ordinary directory',
    )

    const sidecarRepository = await initializedRepository('factory-inspect-sidecar-')
    const sidecarRoot = runtimeJournalRoot(sidecarRepository)
    await rm(join(sidecarRoot, 'journal.sqlite-shm'), { force: true })
    await symlink(external, join(sidecarRoot, 'journal.sqlite-shm'))
    await expect(inspectRuntimeJournal(sidecarRepository)).rejects.toThrow(
      'Runtime path is not an ordinary file',
    )

    const permissionsRepository = await initializedRepository('factory-inspect-permissions-')
    await chmod(runtimeJournalRoot(permissionsRepository), 0o755)
    await expect(inspectRuntimeJournal(permissionsRepository)).rejects.toThrow(
      'Runtime directory ownership is unsafe',
    )

    const diagnosticsRepository = await initializedRepository('factory-inspect-diagnostics-')
    const diagnosticsRoot = join(runtimeJournalRoot(diagnosticsRepository), 'diagnostics')
    await rm(diagnosticsRoot, { recursive: true })
    await symlink(external, diagnosticsRoot)
    await expect(inspectRuntimeJournal(diagnosticsRepository)).rejects.toThrow(
      'Runtime path is not an ordinary directory',
    )

    const fileRepository = await initializedRepository('factory-inspect-file-permissions-')
    const journal = await openRuntimeJournal({ repositoryRoot: fileRepository })
    const diagnosticId = await journal.recordDiagnostic(new Error('unsafe permissions'))
    await journal.close()
    await chmod(
      join(runtimeJournalRoot(fileRepository), 'diagnostics', `${diagnosticId}.txt`),
      0o644,
    )
    await expect(inspectRuntimeJournal(fileRepository)).rejects.toThrow(
      'Runtime storage ownership is unsafe',
    )
  })

  test('rejects an oversized runtime database before SQLite opens it', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'factory-inspect-oversized-'))
    await mkdir(join(repository, '.git'))
    await (await openRuntimeJournal({ repositoryRoot: repository })).close()
    const databasePath = join(repository, '.git', 'factory-runtime', 'journal-v1', 'journal.sqlite')
    const database = await open(databasePath, 'r+')
    await database.truncate(512 * 1024 * 1024 + 1)
    await database.close()

    await expect(inspectRuntimeJournal(repository)).rejects.toThrow(
      'Runtime file exceeds its byte bound',
    )
  })

  test('rejects a physically valid completion without its durable claim', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'factory-inspect-forged-'))
    await mkdir(join(repository, '.git'))
    const journal = await openRuntimeJournal({
      repositoryRoot: repository,
      verifyTurn: turnVerifier(repository),
    })
    await journal.append({
      ...capture('forged-completion-stop', 'stop'),
      eventKind: 'stop',
      stopId: 'stop-1',
    })
    const claim = (await journal.claimStop(crashStop)).claim
    const turn = await writeTurn(repository, 'codex', 'crash-session', 'stop-1', 'completion')
    await prepareTurn(journal, claim, turn)
    await journal.complete(claim, turn)
    await journal.close()

    const { Database } = await import('bun:sqlite')
    const database = new Database(
      join(repository, '.git', 'factory-runtime', 'journal-v1', 'journal.sqlite'),
    )
    database.run('DELETE FROM claims')
    database.close()

    await expect(inspectRuntimeJournal(repository)).rejects.toThrow(
      'Completion does not match its durable claim',
    )
  })

  test('serializes concurrent calls sharing one journal handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-one-handle-'))
    const journal = await openRuntimeJournal({
      testRuntimeRoot: root,
      onDurabilityBoundary: async boundary => {
        if (boundary === 'journal-transaction-staged') await Bun.sleep(5)
      },
    })

    const receipts = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        journal.append(capture(`same-handle-${index}`, `payload-${index}`)),
      ),
    )

    expect(receipts.map(receipt => receipt.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    )
  })

  test('drains entered operations before close and rejects deterministic use after close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-close-'))
    let releaseBoundary = () => {}
    let markReached = () => {}
    const boundary = new Promise<void>(resolve => {
      releaseBoundary = resolve
    })
    const reached = new Promise<void>(resolve => {
      markReached = resolve
    })
    const journal = await openRuntimeJournal({
      testRuntimeRoot: root,
      onDurabilityBoundary: async value => {
        if (value === 'journal-transaction-staged') {
          markReached()
          await boundary
        }
      },
    })
    const append = journal.append(capture('entered', 'payload'))
    await reached
    const closing = journal.close()

    await expect(journal.append(capture('late', 'payload'))).rejects.toThrow('closing or closed')
    releaseBoundary()
    expect((await append).sequence).toBe(0)
    await closing
    await journal.close()
    await expect(journal.inventory()).rejects.toThrow('closing or closed')
    expect(await journal.appendNonBlocking(capture('closed', 'payload'))).toEqual({})
  })

  test('does not let a paused recovery consumer hold shutdown open', async () => {
    const root = await preparedStopRoot()
    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    const iterator = journal.recover()[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)

    expect(
      await Promise.race([
        journal.close().then(() => 'closed'),
        Bun.sleep(100).then(() => 'timed-out'),
      ]),
    ).toBe('closed')
    await iterator.return?.()
  })

  test('freezes one idempotent Stop claim and recovers it until exact completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-journal-'))
    const journal = await openRuntimeJournal({
      testRuntimeRoot: root,
      verifyTurn: turnVerifier(root),
    })
    const common = {
      provider: 'codex' as const,
      sessionId: 'session-stop',
      generation: 3,
      occurredAt: '2026-09-04T00:00:00Z',
    }
    await journal.append({
      ...common,
      eventId: 'event-before',
      eventKind: 'turn',
      raw: new TextEncoder().encode('before'),
    })
    await journal.append({
      ...common,
      eventId: 'event-stop',
      eventKind: 'stop',
      stopId: 'stop-1',
      raw: new TextEncoder().encode('stop'),
    })
    const stop = {
      provider: common.provider,
      sessionId: common.sessionId,
      generation: common.generation,
      stopId: 'stop-1',
    }
    const firstResult = await journal.claimStop(stop)
    const retried = await journal.claimStop(stop)

    expect(firstResult.status).toBe('acquired')
    expect(retried).toEqual({ status: 'already-claimed', claim: firstResult.claim })
    const first = firstResult.claim
    expect(first.throughSequence).toBe(1)
    expect(first.eventKeys).toHaveLength(2)
    expect(await Array.fromAsync(journal.recover())).toEqual([
      { availability: 'ready', stop, claim: first, events: expect.any(Array) },
    ])
    const claimedEvents = await journal.readClaimEvents(first)
    expect(claimedEvents.map(item => item.event.eventId)).toEqual(['event-before', 'event-stop'])
    expect(claimedEvents.map(item => new TextDecoder().decode(item.raw))).toEqual([
      'before',
      'stop',
    ])

    const turn = await writeTurn(root, 'codex', 'session-stop', 'stop-1', 'immutable turn')
    await prepareTurn(journal, first, turn)
    await journal.complete(first, turn)
    await journal.complete(first, turn)
    expect(await Array.fromAsync(journal.recover())).toEqual([])
    await expect(journal.complete(first, { ...turn, sha256: 'b'.repeat(64) })).rejects.toThrow(
      'bytes do not match',
    )
  })

  test('recovers routing metadata and starts each Turn after the preceding Stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-multiple-stops-'))
    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    const append = (eventId: string, eventKind: 'turn' | 'stop', stopId?: string) =>
      journal.append({
        provider: 'claude',
        sessionId: 'continued',
        generation: 0,
        eventId,
        eventKind,
        ...(stopId ? { stopId } : {}),
        occurredAt: `2026-09-04T00:00:0${eventId.at(-1)}Z`,
        worktreePath: '/repository/worktrees/feature',
        raw: new TextEncoder().encode(eventId),
      })
    await append('event-1', 'turn')
    await append('event-2', 'stop', 'stop-1')
    await append('event-3', 'turn')
    await append('event-4', 'stop', 'stop-2')

    const second = await journal.claimStop({
      provider: 'claude',
      sessionId: 'continued',
      generation: 0,
      stopId: 'stop-2',
    })
    const recovered = (await Array.fromAsync(journal.recover())).find(
      item => item.stop.stopId === 'stop-2',
    )

    expect(recovered).toBeDefined()
    expect(recovered!.events.map(event => event.eventKey)).toEqual(second.claim.eventKeys)
    expect(recovered?.events.map(event => event.eventId)).toEqual(['event-3', 'event-4'])
    expect(recovered?.events.map(event => event.eventKind)).toEqual(['turn', 'stop'])
    expect(recovered?.events.map(event => event.worktreePath)).toEqual([
      '/repository/worktrees/feature',
      '/repository/worktrees/feature',
    ])
  })

  test('applies recovery limits to the current Turn rather than full session history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-long-session-'))
    await (await openRuntimeJournal({ testRuntimeRoot: root })).close()
    const { Database } = await import('bun:sqlite')
    const database = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    const scope = (
      database.query('SELECT runtime_scope FROM journal_meta').get() as { runtime_scope: string }
    ).runtime_scope
    const insert = database.query('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    database.transaction(() => {
      for (let sequence = 0; sequence < 10_000; sequence += 1) {
        const eventId = `historical-${sequence}`
        insert.run(
          sequence,
          testIdentity(scope, 'codex', 'long-session', '0', eventId),
          'codex',
          'long-session',
          0,
          eventId,
          'turn',
          '2026-09-04T00:00:00Z',
          null,
          null,
          '0'.repeat(64),
          0,
        )
      }
      insert.run(
        10_000,
        testIdentity(scope, 'codex', 'long-session', '0', 'historical-stop'),
        'codex',
        'long-session',
        0,
        'historical-stop',
        'stop',
        '2026-09-04T00:00:00Z',
        'stop-1',
        null,
        '0'.repeat(64),
        0,
      )
      database.run('UPDATE journal_meta SET next_sequence=10001')
    })()
    database.close()

    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    await journal.append({
      provider: 'codex',
      sessionId: 'long-session',
      generation: 0,
      eventId: 'current-turn',
      eventKind: 'turn',
      occurredAt: '2026-09-04T00:00:01Z',
      raw: new TextEncoder().encode('current'),
    })
    await journal.append({
      provider: 'codex',
      sessionId: 'long-session',
      generation: 0,
      eventId: 'current-stop',
      eventKind: 'stop',
      stopId: 'stop-2',
      occurredAt: '2026-09-04T00:00:02Z',
      raw: new TextEncoder().encode('stop'),
    })

    const result = await journal.claimStop({
      provider: 'codex',
      sessionId: 'long-session',
      generation: 0,
      stopId: 'stop-2',
    })
    expect(result.status).toBe('acquired')
    expect(result.claim.eventKeys).toHaveLength(2)
  })

  test('reports one oversized Turn without starving recoverable Stops in other sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-recovery-starvation-'))
    await (await openRuntimeJournal({ testRuntimeRoot: root })).close()
    const { Database } = await import('bun:sqlite')
    const database = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    const scope = (
      database.query('SELECT runtime_scope FROM journal_meta').get() as { runtime_scope: string }
    ).runtime_scope
    const insert = database.query('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    database.transaction(() => {
      for (let sequence = 0; sequence < 10_001; sequence += 1) {
        const eventId = `oversized-${sequence}`
        insert.run(
          sequence,
          testIdentity(scope, 'codex', 'oversized-session', '0', eventId),
          'codex',
          'oversized-session',
          0,
          eventId,
          'turn',
          '2026-09-04T00:00:00Z',
          null,
          null,
          '0'.repeat(64),
          0,
        )
      }
      insert.run(
        10_001,
        testIdentity(scope, 'codex', 'oversized-session', '0', 'oversized-stop'),
        'codex',
        'oversized-session',
        0,
        'oversized-stop',
        'stop',
        '2026-09-04T00:00:01Z',
        'oversized-stop',
        null,
        '0'.repeat(64),
        0,
      )
      database.run('UPDATE journal_meta SET next_sequence=10002')
    })()
    database.close()

    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    await journal.append({
      provider: 'claude',
      sessionId: 'ready-session',
      generation: 0,
      eventId: 'ready-stop',
      eventKind: 'stop',
      stopId: 'ready-stop',
      occurredAt: '2026-09-04T00:00:02Z',
      raw: new TextEncoder().encode('ready'),
    })

    const recovered = await Array.fromAsync(journal.recover())
    expect(recovered.map(item => item.availability)).toEqual(['unavailable', 'ready'])
    expect(recovered[0]).toMatchObject({
      availability: 'unavailable',
      stop: { sessionId: 'oversized-session', stopId: 'oversized-stop' },
      limitation: { kind: 'event-count', limit: 10_000, observed: 10_002 },
    })
    expect(recovered[1]).toMatchObject({
      availability: 'ready',
      stop: { sessionId: 'ready-session', stopId: 'ready-stop' },
      events: [{ eventId: 'ready-stop' }],
    })
  })

  test('rejects an oversized Turn before persisting its permanent claim fence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-oversized-turn-'))
    await (await openRuntimeJournal({ testRuntimeRoot: root })).close()
    const { Database } = await import('bun:sqlite')
    const database = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    const scope = (
      database.query('SELECT runtime_scope FROM journal_meta').get() as { runtime_scope: string }
    ).runtime_scope
    const insert = database.query('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    insert.run(
      0,
      testIdentity(scope, 'codex', 'large-turn', '0', 'large-event'),
      'codex',
      'large-turn',
      0,
      'large-event',
      'turn',
      '2026-09-04T00:00:00Z',
      null,
      null,
      '0'.repeat(64),
      40 * 1024 * 1024,
    )
    insert.run(
      1,
      testIdentity(scope, 'codex', 'large-turn', '0', 'large-stop'),
      'codex',
      'large-turn',
      0,
      'large-stop',
      'stop',
      '2026-09-04T00:00:01Z',
      'stop-1',
      null,
      '1'.repeat(64),
      40 * 1024 * 1024,
    )
    database.run('UPDATE journal_meta SET next_sequence=2')
    database.close()

    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    await expect(
      journal.claimStop({
        provider: 'codex',
        sessionId: 'large-turn',
        generation: 0,
        stopId: 'stop-1',
      }),
    ).rejects.toThrow('raw-byte recovery bound')
    const reopened = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    expect(
      (reopened.query('SELECT COUNT(*) AS count FROM claims').get() as { count: number }).count,
    ).toBe(0)
    reopened.close()
  })

  test('rejects aggregate event metadata before loading an unbounded journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-metadata-bound-'))
    await (await openRuntimeJournal({ testRuntimeRoot: root })).close()
    const { Database } = await import('bun:sqlite')
    const database = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    const scope = (
      database.query('SELECT runtime_scope FROM journal_meta').get() as { runtime_scope: string }
    ).runtime_scope
    const insert = database.query('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    const worktreePath = `/${'x'.repeat(32 * 1024 - 1)}`
    database.transaction(() => {
      for (let sequence = 0; sequence < 2050; sequence += 1) {
        const eventId = `metadata-${sequence}`
        insert.run(
          sequence,
          testIdentity(scope, 'codex', 'metadata-session', '0', eventId),
          'codex',
          'metadata-session',
          0,
          eventId,
          'turn',
          '2026-09-04T00:00:00Z',
          null,
          worktreePath,
          '0'.repeat(64),
          0,
        )
      }
      database.run('UPDATE journal_meta SET next_sequence=2050')
    })()
    database.close()

    await expect(openRuntimeJournal({ testRuntimeRoot: root })).rejects.toThrow(
      'event metadata byte bound',
    )
  })

  test('rolls back a capture that would cross the event metadata bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-metadata-capacity-'))
    await (await openRuntimeJournal({ testRuntimeRoot: root })).close()
    const { Database } = await import('bun:sqlite')
    const database = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    const scope = (
      database.query('SELECT runtime_scope FROM journal_meta').get() as { runtime_scope: string }
    ).runtime_scope
    const insert = database.query('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    const worktreePath = `/${'x'.repeat(32 * 1024 - 1)}`
    database.transaction(() => {
      for (let sequence = 0; sequence < 2034; sequence += 1) {
        const eventId = `metadata-${sequence}`
        insert.run(
          sequence,
          testIdentity(scope, 'codex', 'metadata-session', '0', eventId),
          'codex',
          'metadata-session',
          0,
          eventId,
          'turn',
          '2026-09-04T00:00:00Z',
          null,
          worktreePath,
          '0'.repeat(64),
          0,
        )
      }
      database.run('UPDATE journal_meta SET next_sequence=2034')
    })()
    database.close()

    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    await expect(
      journal.append({
        provider: 'codex',
        sessionId: 'metadata-session',
        generation: 0,
        eventId: 'crosses-bound',
        eventKind: 'turn',
        occurredAt: '2026-09-04T00:00:01Z',
        worktreePath,
        raw: new TextEncoder().encode('not acknowledged'),
      }),
    ).rejects.toThrow('event metadata byte bound')
    const reopened = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    expect(
      reopened.query('SELECT COUNT(*) AS count FROM events').get() as { count: number },
    ).toEqual({ count: 2034 })
    expect(reopened.query('SELECT next_sequence FROM journal_meta').get()).toEqual({
      next_sequence: 2034,
    })
    reopened.close()
  })

  test('rejects an oversized persisted claim before parsing its JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-claim-json-bound-'))
    await (await openRuntimeJournal({ testRuntimeRoot: root })).close()
    const { Database } = await import('bun:sqlite')
    const database = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    database
      .query('INSERT INTO claims VALUES(?,?)')
      .run('0'.repeat(64), 'x'.repeat(1024 * 1024 + 1))
    database.close()

    await expect(openRuntimeJournal({ testRuntimeRoot: root })).rejects.toThrow(
      'Claim JSON exceeds its byte bound',
    )
  })

  test('rejects an oversized persisted completion before parsing its JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-completion-json-bound-'))
    await (await openRuntimeJournal({ testRuntimeRoot: root })).close()
    const { Database } = await import('bun:sqlite')
    const database = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    database
      .query('INSERT INTO completions VALUES(?,?)')
      .run('0'.repeat(64), 'x'.repeat(128 * 1024 + 1))
    database.close()

    await expect(openRuntimeJournal({ testRuntimeRoot: root })).rejects.toThrow(
      'Completion JSON exceeds its byte bound',
    )
  })

  test('recovers pending Stops after completed Turn raw bytes are reclaimed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-reclaimed-'))
    const journal = await openRuntimeJournal({
      testRuntimeRoot: root,
      verifyTurn: turnVerifier(root),
    })
    const first = await journal.append({
      ...capture('stop-one', 'first'),
      eventKind: 'stop',
      stopId: 'stop-1',
    })
    const firstStop = { ...crashStop, stopId: 'stop-1' }
    const firstClaim = (await journal.claimStop(firstStop)).claim
    const firstTurn = await writeTurn(root, 'codex', 'crash-session', 'stop-1', 'turn one')
    await prepareTurn(journal, firstClaim, firstTurn)
    await journal.complete(firstClaim, firstTurn)
    await journal.append({ ...capture('between', 'between') })
    await journal.append({ ...capture('stop-two', 'second'), eventKind: 'stop', stopId: 'stop-2' })
    await Bun.file(rawPath(root, first.rawSha256)).delete()

    const recovered = await Array.fromAsync(journal.recover())

    expect(recovered.map(item => item.stop.stopId)).toEqual(['stop-2'])
    expect(recovered[0]?.events.map(event => event.eventId)).toEqual(['between', 'stop-two'])
  })

  test('re-establishes directory durability when retrying an already-published raw object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-existing-raw-'))
    await killWorker(root, 'append', 'raw-published')
    const reached: DurabilityBoundary[] = []
    const journal = await openRuntimeJournal({
      testRuntimeRoot: root,
      onDurabilityBoundary: boundary => {
        reached.push(boundary)
      },
    })

    await journal.append(capture('event-1', 'crash-payload'))

    expect(reached).toContain('raw-directory-synced')
    expect(reached).toContain('journal-transaction-committed')
  })

  test('authorizes exactly one concurrent materializer and fences the rest', async () => {
    const root = await preparedStopRoot()
    const workers = Array.from({ length: 8 }, () =>
      Bun.spawn(['bun', new URL('./claim-worker.ts', import.meta.url).pathname, root], {
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    const results = await Promise.all(
      workers.map(async worker => {
        expect(await worker.exited).toBe(0)
        return JSON.parse(await new Response(worker.stdout).text())
      }),
    )

    expect(results.filter(result => result.status === 'acquired')).toHaveLength(1)
    expect(results.filter(result => result.status === 'already-claimed')).toHaveLength(7)
    expect(new Set(results.map(result => JSON.stringify(result.claim))).size).toBe(1)
    expect(results[0].claim.stop).toEqual(crashStop)
    expect(results[0].claim.throughSequence).toBe(0)
    expect(results[0].claim.eventKeys).toHaveLength(1)
  })

  test('reopens and idempotently retries after process death at every append boundary', async () => {
    const boundaries: DurabilityBoundary[] = [
      'raw-file-synced',
      'raw-published',
      'raw-directory-synced',
      'journal-transaction-staged',
      'journal-commit-attempt',
      'journal-transaction-committed',
    ]
    for (const boundary of boundaries) {
      const root = await mkdtemp(join(tmpdir(), `factory-crash-${boundary}-`))
      const child = Bun.spawn(
        ['bun', new URL('./crash-worker.ts', import.meta.url).pathname, root, 'append', boundary],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      expect(await child.exited).not.toBe(0)
      expect(await readFile(join(root, `reached-${boundary}`), 'utf8')).toBe(boundary)

      const reopened = await openRuntimeJournal({ testRuntimeRoot: root })
      const receipt = await reopened.append(capture('event-1', 'crash-payload'))
      expect(receipt.sequence).toBe(0)
      expect((await reopened.inventory()).referenced).toHaveLength(1)
    }
  }, 30_000)

  test('reopens the same claim and completion after death at every state boundary', async () => {
    const claimBoundaries: DurabilityBoundary[] = [
      'claim-transaction-staged',
      'claim-commit-attempt',
      'claim-transaction-committed',
    ]
    const completionBoundaries: DurabilityBoundary[] = [
      'completion-transaction-staged',
      'completion-commit-attempt',
      'completion-transaction-committed',
    ]
    for (const boundary of claimBoundaries) {
      const root = await preparedStopRoot()
      await killWorker(root, 'claim', boundary)
      const reopened = await openRuntimeJournal({ testRuntimeRoot: root })
      const result = await reopened.claimStop(crashStop)
      expect(result.claim.throughSequence).toBe(0)
      expect((await Array.fromAsync(reopened.recover()))[0]?.claim).toEqual(result.claim)
    }
    for (const boundary of completionBoundaries) {
      const root = await preparedStopRoot()
      const turn = await writeTurn(root, 'codex', 'crash-session', 'stop-1', 'crash turn')
      const journal = await openRuntimeJournal({
        testRuntimeRoot: root,
        verifyTurn: turnVerifier(root),
      })
      const claim = (await journal.claimStop(crashStop)).claim
      await prepareTurn(journal, claim, turn)
      await killWorker(root, 'complete', boundary, {
        FACTORY_TEST_CLAIM: JSON.stringify(claim),
        FACTORY_TEST_TURN: JSON.stringify(turn),
      })
      const reopened = await openRuntimeJournal({
        testRuntimeRoot: root,
        verifyTurn: turnVerifier(root),
      })
      await reopened.complete(claim, turn)
      expect(await Array.fromAsync(reopened.recover())).toEqual([])
    }
  }, 30_000)

  test('reports raw and row corruption instead of inventing recovery work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-corrupt-'))
    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    const receipt = await journal.append({
      ...capture('event-1', 'original'),
      eventKind: 'stop',
      stopId: 'stop-corrupt',
    })
    const rawPath = join(
      root,
      'journal-v1',
      'objects',
      'sha256',
      receipt.rawSha256.slice(0, 2),
      receipt.rawSha256.slice(2),
    )
    await writeFile(rawPath, 'corrupt')
    await expect(Array.fromAsync(journal.recover())).rejects.toBeInstanceOf(JournalCorruptionError)

    const secondRoot = await mkdtemp(join(tmpdir(), 'factory-row-corrupt-'))
    const second = await openRuntimeJournal({ testRuntimeRoot: secondRoot })
    await second.append(capture('event-1', 'valid'))
    const { Database } = await import('bun:sqlite')
    const database = new Database(join(secondRoot, 'journal-v1', 'journal.sqlite'))
    database.run('UPDATE events SET sequence = 9 WHERE sequence = 0')
    database.close()
    await expect(Array.fromAsync(second.recover())).rejects.toBeInstanceOf(JournalCorruptionError)
  })

  test('checks raw size before reading an externally enlarged object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-raw-bound-'))
    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    const receipt = await journal.append(capture('event-1', 'small'))
    const handle = await open(rawPath(root, receipt.rawSha256), 'r+')
    await handle.truncate(64 * 1024 * 1024 + 1)
    await handle.close()

    await expect(journal.readRaw(receipt)).rejects.toThrow('byte bound')
  })

  test('rejects forged claim state and inconsistent logical metadata before acknowledgement', async () => {
    const { Database } = await import('bun:sqlite')
    for (const mutation of [
      (claim: Record<string, unknown>) => ({ ...claim, claimId: `claim_${'0'.repeat(64)}` }),
      (claim: Record<string, unknown>) => ({ ...claim, throughSequence: 9 }),
      (claim: Record<string, unknown>) => ({ ...claim, eventKeys: [] }),
      (claim: Record<string, unknown>) => ({ ...claim, claimedAt: 'not-a-timestamp' }),
    ]) {
      const root = await preparedStopRoot()
      const journal = await openRuntimeJournal({ testRuntimeRoot: root })
      const original = (await journal.claimStop(crashStop)).claim
      const database = new Database(join(root, 'journal-v1', 'journal.sqlite'))
      database
        .query('UPDATE claims SET claim_json=?')
        .run(JSON.stringify(mutation(original as unknown as Record<string, unknown>)))
      database.close()
      await expect(journal.claimStop(crashStop)).rejects.toBeInstanceOf(JournalCorruptionError)
    }

    const counterRoot = await mkdtemp(join(tmpdir(), 'factory-counter-corrupt-'))
    const counterJournal = await openRuntimeJournal({ testRuntimeRoot: counterRoot })
    await counterJournal.append(capture('event-1', 'one'))
    const counterDb = new Database(join(counterRoot, 'journal-v1', 'journal.sqlite'))
    counterDb.run('UPDATE journal_meta SET next_sequence=7')
    counterDb.close()
    await expect(counterJournal.append(capture('event-2', 'two'))).rejects.toBeInstanceOf(
      JournalCorruptionError,
    )

    const keyRoot = await mkdtemp(join(tmpdir(), 'factory-key-corrupt-'))
    const keyJournal = await openRuntimeJournal({ testRuntimeRoot: keyRoot })
    await keyJournal.append(capture('event-1', 'one'))
    const keyDb = new Database(join(keyRoot, 'journal-v1', 'journal.sqlite'))
    keyDb.query('UPDATE events SET event_key=?').run('f'.repeat(64))
    keyDb.close()
    await expect(keyJournal.claimStop(crashStop)).rejects.toBeInstanceOf(JournalCorruptionError)

    const claimKeyRoot = await preparedStopRoot()
    const claimKeyJournal = await openRuntimeJournal({ testRuntimeRoot: claimKeyRoot })
    await claimKeyJournal.claimStop(crashStop)
    const claimKeyDb = new Database(join(claimKeyRoot, 'journal-v1', 'journal.sqlite'))
    claimKeyDb.query('UPDATE claims SET stop_key=?').run('e'.repeat(64))
    claimKeyDb.close()
    await expect(Array.fromAsync(claimKeyJournal.recover())).rejects.toBeInstanceOf(
      JournalCorruptionError,
    )

    const completionRoot = await preparedStopRoot()
    const completionJournal = await openRuntimeJournal({
      testRuntimeRoot: completionRoot,
      verifyTurn: turnVerifier(completionRoot),
    })
    const completionClaim = (await completionJournal.claimStop(crashStop)).claim
    const completionTurn = await writeTurn(
      completionRoot,
      'codex',
      'crash-session',
      'stop-1',
      'completion',
    )
    await prepareTurn(completionJournal, completionClaim, completionTurn)
    await completionJournal.complete(completionClaim, completionTurn)
    const completionDb = new Database(join(completionRoot, 'journal-v1', 'journal.sqlite'))
    const storedCompletion = completionDb
      .query('SELECT completion_json FROM completions')
      .get() as { completion_json: string }
    const forgedCompletion = JSON.parse(storedCompletion.completion_json)
    forgedCompletion.claimId = `claim_${'0'.repeat(64)}`
    completionDb
      .query('UPDATE completions SET completion_json=?')
      .run(JSON.stringify(forgedCompletion))
    completionDb.close()
    await expect(
      completionJournal.append(capture('after-corruption', 'payload')),
    ).rejects.toBeInstanceOf(JournalCorruptionError)
  })

  test('requires a verified owned immutable Turn before suppressing recovery', async () => {
    const root = await preparedStopRoot()
    const claim = (await (await openRuntimeJournal({ testRuntimeRoot: root })).claimStop(crashStop))
      .claim
    const withoutCapability = await openRuntimeJournal({ testRuntimeRoot: root })
    await expect(
      withoutCapability.complete(claim, {
        path: makeOwnedPath('sessions', [
          'codex',
          'crash-session',
          'turns',
          'stop-1',
          'manifest.json',
        ]),
        sha256: 'a'.repeat(64),
        repositoryRoot: root,
        repositoryId: 'repo_fixture',
      }),
    ).rejects.toThrow('Turn-verification capability')
    const withCapability = await openRuntimeJournal({
      testRuntimeRoot: root,
      verifyTurn: async () => new TextEncoder().encode('different bytes'),
    })
    await expect(
      Reflect.apply(withCapability.complete, withCapability, [
        claim,
        { path: 'reviews/not-a-turn.json', sha256: 'a'.repeat(64) },
      ]),
    ).rejects.toThrow('valid claim and Turn reference')
    await expect(
      withCapability.complete(claim, {
        path: makeOwnedPath('sessions', [
          'codex',
          'crash-session',
          'turns',
          'stop-1',
          'manifest.json',
        ]),
        sha256: 'a'.repeat(64),
        repositoryRoot: root,
        repositoryId: 'repo_fixture',
      }),
    ).rejects.toThrow('bytes do not match')
    expect(await Array.fromAsync(withCapability.recover())).toHaveLength(1)
  })

  test('rolls back SQLite ENOSPC at every commit boundary and reopens durable truth', async () => {
    const full = () => Object.assign(new Error('injected SQLite disk full'), { code: 'ENOSPC' })

    const appendRoot = await mkdtemp(join(tmpdir(), 'factory-db-full-append-'))
    const appendJournal = await openRuntimeJournal({
      testRuntimeRoot: appendRoot,
      onDurabilityBoundary: boundary => {
        if (boundary === 'journal-commit-attempt') throw full()
      },
    })
    await expect(appendJournal.append(capture('event-1', 'one'))).rejects.toThrow('disk full')
    const appendReopened = await openRuntimeJournal({ testRuntimeRoot: appendRoot })
    expect((await appendReopened.append(capture('event-1', 'one'))).sequence).toBe(0)

    const claimRoot = await preparedStopRoot()
    const claimJournal = await openRuntimeJournal({
      testRuntimeRoot: claimRoot,
      onDurabilityBoundary: boundary => {
        if (boundary === 'claim-commit-attempt') throw full()
      },
    })
    await expect(claimJournal.claimStop(crashStop)).rejects.toThrow('disk full')
    expect(
      (await (await openRuntimeJournal({ testRuntimeRoot: claimRoot })).claimStop(crashStop))
        .status,
    ).toBe('acquired')

    const completionRoot = await preparedStopRoot()
    const completionTurn = await writeTurn(
      completionRoot,
      'codex',
      'crash-session',
      'stop-1',
      'complete',
    )
    const completionClaim = (
      await (await openRuntimeJournal({ testRuntimeRoot: completionRoot })).claimStop(crashStop)
    ).claim
    const completionJournal = await openRuntimeJournal({
      testRuntimeRoot: completionRoot,
      verifyTurn: turnVerifier(completionRoot),
      onDurabilityBoundary: boundary => {
        if (boundary === 'completion-commit-attempt') throw full()
      },
    })
    await prepareTurn(completionJournal, completionClaim, completionTurn)
    await expect(completionJournal.complete(completionClaim, completionTurn)).rejects.toThrow(
      'disk full',
    )
    expect(
      await Array.fromAsync(
        (await openRuntimeJournal({ testRuntimeRoot: completionRoot })).recover(),
      ),
    ).toHaveLength(1)
  })

  test('rejects symlinked runtime ownership and keeps runtime state private', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-private-'))
    const target = await mkdtemp(join(tmpdir(), 'factory-symlink-target-'))
    await symlink(target, join(root, 'journal-v1'))
    await expect(openRuntimeJournal({ testRuntimeRoot: root })).rejects.toBeInstanceOf(
      JournalCorruptionError,
    )

    const privateRoot = await mkdtemp(join(tmpdir(), 'factory-private-modes-'))
    await openRuntimeJournal({ testRuntimeRoot: privateRoot })
    expect((await Bun.file(join(privateRoot, 'journal-v1')).stat()).mode & 0o777).toBe(0o700)
    expect(
      (await Bun.file(join(privateRoot, 'journal-v1', 'journal.sqlite')).stat()).mode & 0o777,
    ).toBe(0o600)
  })

  test('keeps hook failures nonblocking and leaves a private diagnostic when possible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-nonblocking-'))
    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    await journal.append(capture('same-event', 'first'))

    const result = await journal.appendNonBlocking(capture('same-event', 'conflict'))

    expect(result.receipt).toBeUndefined()
    expect(result.diagnosticId).toBeString()
    const diagnostic = await readFile(
      join(root, 'journal-v1', 'diagnostics', `${result.diagnosticId}.txt`),
      'utf8',
    )
    expect(diagnostic).toContain('ConflictingCaptureError')

    const repeated = await journal.appendNonBlocking(capture('same-event', 'conflict'))
    expect(repeated.diagnosticId).toBe(result.diagnosticId)
    expect(await readdir(join(root, 'journal-v1', 'diagnostics'))).toEqual([
      `${result.diagnosticId}.txt`,
    ])

    await rm(join(root, 'journal-v1', 'diagnostics'), { recursive: true })
    await writeFile(join(root, 'journal-v1', 'diagnostics'), 'unavailable')
    expect(await journal.appendNonBlocking(capture('same-event', 'another conflict'))).toEqual({})
  })

  test('does not acknowledge or allocate a sequence when the runtime disk is full', async () => {
    const root = process.env.FACTORY_DISK_FULL_ROOT
    if (!root) throw new Error('disk-full oracle requires the Docker test environment')
    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    const tooLarge = { ...capture('large-event', ''), raw: new Uint8Array(2 * 1024 * 1024) }

    await expect(journal.append(tooLarge)).rejects.toThrow()

    const receipt = await journal.append(capture('small-event', 'fits'))
    expect(receipt.sequence).toBe(0)
  })

  test('recovers SessionEnd independently after the last completed Stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-lifecycle-'))
    const journal = await openRuntimeJournal({
      testRuntimeRoot: root,
      verifyLifecycle: async (_event, reference) =>
        new Uint8Array(await readFile(join(root, '.factory', reference.path))),
    })
    await journal.append({
      provider: 'claude',
      sessionId: 'ended-session',
      generation: 0,
      eventId: 'session-end',
      eventKind: 'session-end',
      occurredAt: '2026-09-04T00:00:03Z',
      raw: new TextEncoder().encode('{"hook_event_name":"SessionEnd"}'),
    })
    const event = (await Array.fromAsync(journal.recoverLifecycle()))[0]!
    expect(event.eventKind).toBe('session-end')
    const path = makeOwnedPath('sessions', [
      'claude',
      'claude-session',
      'lifecycle',
      `event_${'0'.repeat(26)}.json`,
    ])
    const bytes = new TextEncoder().encode(
      canonicalJson({
        schemaVersion: 1,
        eventId: `event_${'0'.repeat(26)}`,
        sessionKey: 'claude-session',
        providerEvent: 'SessionEnd',
        observedAt: event.occurredAt,
        evidence: {
          algorithm: 'sha256',
          sha256: event.rawSha256,
          bytes: event.byteLength,
          mediaType: 'application/json',
          role: 'provider-hook',
        },
      }),
    )
    await mkdir(join(root, '.factory', 'sessions', 'claude', 'claude-session', 'lifecycle'), {
      recursive: true,
    })
    await writeFile(join(root, '.factory', path), bytes)
    const reference = {
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      repositoryRoot: root,
      repositoryId: 'repo_fixture',
    }
    await journal.prepareCapture(
      { kind: 'lifecycle', event },
      {
        objects: [],
        records: [await prepareFixtureRecord(root, path, bytes)],
        commitPath: path,
        completion: { path, sha256: reference.sha256 },
      },
    )
    await journal.completeLifecycle(event, reference)
    await journal.completeLifecycle(event, reference)
    expect(await Array.fromAsync(journal.recoverLifecycle())).toEqual([])
  })

  test('rebuilds recovery solely from authoritative rows after derived indexes are deleted', async () => {
    const root = await preparedStopRoot()
    const { Database } = await import('bun:sqlite')
    const database = new Database(join(root, 'journal-v1', 'journal.sqlite'))
    database.run('DROP INDEX events_by_session_sequence')
    database.close()

    const journal = await openRuntimeJournal({ testRuntimeRoot: root })
    const work = await Array.fromAsync(journal.recover())

    expect(work.map(item => item.stop)).toEqual([crashStop])
    expect(work[0]?.events.map(event => event.sequence)).toEqual([0])
  })
})

const crashStop = {
  provider: 'codex' as const,
  sessionId: 'crash-session',
  generation: 0,
  stopId: 'stop-1',
}

function capture(eventId: string, raw: string) {
  return {
    provider: 'codex' as const,
    sessionId: 'crash-session',
    generation: 0,
    eventId,
    eventKind: 'turn' as const,
    occurredAt: '2026-09-04T00:00:00Z',
    raw: new TextEncoder().encode(raw),
  }
}

function testIdentity(...parts: string[]): string {
  return createHash('sha256')
    .update(parts.map(part => `${part.length}:${part}`).join('|'))
    .digest('hex')
}

function rawPath(root: string, sha256: string): string {
  return join(root, 'journal-v1', 'objects', 'sha256', sha256.slice(0, 2), sha256.slice(2))
}

async function initializedRepository(prefix: string): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(repository, '.git'))
  await (await openRuntimeJournal({ repositoryRoot: repository })).close()
  return repository
}

function runtimeJournalRoot(repository: string): string {
  return join(repository, '.git', 'factory-runtime', 'journal-v1')
}

async function treeFingerprint(root: string, relative = ''): Promise<readonly string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  const fingerprints: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(relative, entry.name)
    const info = await lstat(join(root, path))
    if (entry.isDirectory()) {
      fingerprints.push(`directory:${path}:${info.mode & 0o777}`)
      fingerprints.push(...(await treeFingerprint(root, path)))
    } else {
      const sha256 = createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex')
      fingerprints.push(`file:${path}:${info.mode & 0o777}:${sha256}`)
    }
  }
  return fingerprints
}

async function preparedStopRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'factory-stop-crash-'))
  const journal = await openRuntimeJournal({ testRuntimeRoot: root })
  await journal.append({
    ...capture('stop-event', 'crash-payload'),
    eventKind: 'stop',
    stopId: 'stop-1',
  })
  return root
}

async function killWorker(
  root: string,
  operation: string,
  boundary: DurabilityBoundary,
  env: Record<string, string> = {},
): Promise<void> {
  const child = Bun.spawn(
    ['bun', new URL('./crash-worker.ts', import.meta.url).pathname, root, operation, boundary],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } },
  )
  expect(await child.exited).not.toBe(0)
  expect(await readFile(join(root, `reached-${boundary}`), 'utf8')).toBe(boundary)
}

function turnVerifier(root: string) {
  return async (_claim: unknown, turn: { path: string; sha256: string }): Promise<Uint8Array> =>
    new Uint8Array(await readFile(join(root, '.factory', turn.path)))
}

async function prepareTurn(
  journal: RuntimeJournal,
  claim: MaterializationClaim,
  turn: RuntimeRecordRef,
): Promise<void> {
  const bytes = new Uint8Array(await readFile(join(turn.repositoryRoot, '.factory', turn.path)))
  await journal.prepareCapture(
    { kind: 'stop', claim },
    {
      objects: [],
      records: [await prepareFixtureRecord(turn.repositoryRoot, turn.path, bytes)],
      commitPath: turn.path,
      completion: { path: turn.path, sha256: turn.sha256 },
    },
  )
}

async function writeTurn(
  root: string,
  provider: 'codex' | 'claude',
  session: string,
  stop: string,
  content: string,
): Promise<RuntimeRecordRef> {
  const { path, bytes } = turnFixture(provider, session, stop, content)
  await mkdir(dirname(join(root, '.factory', path)), {
    recursive: true,
  })
  await writeFile(join(root, '.factory', path), bytes, { flag: 'wx' })
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    repositoryRoot: root,
    repositoryId: 'repo_fixture',
  }
}
