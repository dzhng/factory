import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { OwnedPath } from '@factory/contract'

export type CaptureProvider = 'codex' | 'claude'
export type CaptureEventKind = 'session-start' | 'turn' | 'stop' | 'session-end' | 'other'

const MAX_DIAGNOSTICS = 10_000

export interface RawCaptureInput {
  provider: CaptureProvider
  sessionId: string
  generation: number
  eventId: string
  eventKind: CaptureEventKind
  occurredAt: string
  raw: Uint8Array
  stopId?: string
  /** Operational routing only. Absolute worktree paths never enter `.factory`. */
  worktreePath?: string
}
export interface DurableCaptureReceipt {
  sequence: number
  eventKey: string
  rawSha256: string
  byteLength: number
}
export interface DurableCaptureEvent extends DurableCaptureReceipt {
  provider: CaptureProvider
  sessionId: string
  generation: number
  eventId: string
  eventKind: CaptureEventKind
  occurredAt: string
  stopId?: string
  worktreePath?: string
}
export interface StopIdentity {
  provider: CaptureProvider
  sessionId: string
  generation: number
  stopId: string
}
export interface MaterializationClaim {
  claimId: string
  stop: StopIdentity
  claimedAt: string
  throughSequence: number
  eventKeys: string[]
}
export type ClaimStopResult =
  | { status: 'acquired'; claim: MaterializationClaim }
  | { status: 'already-claimed'; claim: MaterializationClaim }
export interface TurnRef {
  path: OwnedPath
  sha256: string
}
export interface RuntimeRecordRef extends TurnRef {
  /** Private operational routing; never written to `.factory`. */
  repositoryRoot: string
  repositoryId: string
}
export interface RecoveryLimitation {
  kind: 'event-count' | 'raw-bytes'
  limit: number
  observed: number
}
export type RecoveryWork =
  | {
      availability: 'ready'
      stop: StopIdentity
      claim?: MaterializationClaim
      events: DurableCaptureEvent[]
    }
  | {
      availability: 'unavailable'
      stop: StopIdentity
      claim?: MaterializationClaim
      events: []
      limitation: RecoveryLimitation
    }
export type DurabilityBoundary =
  | 'raw-file-synced'
  | 'raw-published'
  | 'raw-directory-synced'
  | 'journal-transaction-staged'
  | 'journal-transaction-committed'
  | 'claim-transaction-staged'
  | 'claim-transaction-committed'
  | 'completion-transaction-staged'
  | 'completion-transaction-committed'
  | 'journal-commit-attempt'
  | 'claim-commit-attempt'
  | 'completion-commit-attempt'
  | 'lifecycle-completion-transaction-staged'
  | 'lifecycle-completion-transaction-committed'
export interface RuntimeJournalOptions {
  /** Repository worktree used to locate the one Git-common runtime. */
  repositoryRoot?: string
  /** Existing private directory used only by isolated tests and crash labs. */
  testRuntimeRoot?: string
  lockTimeoutMs?: number
  /** Repository-owned capability returning exact bytes for a verified immutable Turn. */
  verifyTurn?: (claim: MaterializationClaim, turn: RuntimeRecordRef) => Promise<Uint8Array>
  /** Repository capability proving one immutable lifecycle record before retirement. */
  verifyLifecycle?: (event: DurableCaptureEvent, record: RuntimeRecordRef) => Promise<Uint8Array>
  /** Crash-lab observation seam. It must not perform journal writes. */
  onDurabilityBoundary?: (boundary: DurabilityBoundary) => void | Promise<void>
}
export interface HookCaptureResult {
  receipt?: DurableCaptureReceipt
  diagnosticId?: string
}
export interface RuntimeJournal {
  append(input: RawCaptureInput): Promise<DurableCaptureReceipt>
  appendNonBlocking(input: RawCaptureInput): Promise<HookCaptureResult>
  claimStop(stop: StopIdentity): Promise<ClaimStopResult>
  complete(claim: MaterializationClaim, turn: RuntimeRecordRef): Promise<void>
  recover(): AsyncIterable<RecoveryWork>
  recoverLifecycle(): AsyncIterable<DurableCaptureEvent>
  completeLifecycle(event: DurableCaptureEvent, record: RuntimeRecordRef): Promise<void>
  readRaw(receipt: DurableCaptureReceipt): Promise<Uint8Array>
  readClaimEvents(
    claim: MaterializationClaim,
  ): Promise<readonly { event: DurableCaptureEvent; raw: Uint8Array }[]>
  inventory(): Promise<{ referenced: string[]; orphaned: string[]; staging: string[] }>
  recordDiagnostic(error: unknown): Promise<string | undefined>
  close(): Promise<void>
}

interface Statement {
  get(...bindings: unknown[]): unknown
  all(...bindings: unknown[]): unknown[]
  run(...bindings: unknown[]): unknown
}
interface Database {
  exec(sql: string): void
  prepare?(sql: string): Statement
  query?(sql: string): Statement
  close(): void
}
interface JournalRow extends DurableCaptureReceipt {
  provider: CaptureProvider
  sessionId: string
  generation: number
  eventId: string
  eventKind: CaptureEventKind
  occurredAt: string
  stopId?: string
  worktreePath?: string
}
interface Completion {
  claimId: string
  stop: StopIdentity
  turn: RuntimeRecordRef
  completedAt: string
}
interface ClaimRange {
  stopRow: JournalRow
  rows: JournalRow[]
}
interface RecoverySnapshot {
  stop: StopIdentity
  claim?: MaterializationClaim
  rows: JournalRow[]
  limitation?: RecoveryLimitation
}

const SHA256 = /^[0-9a-f]{64}$/
const EVENT_KINDS: CaptureEventKind[] = ['session-start', 'turn', 'stop', 'session-end', 'other']
const MAX_IDENTIFIER_BYTES = 4096
const MAX_PATH_BYTES = 32 * 1024
const MAX_RAW_BYTES = 64 * 1024 * 1024
const MAX_JOURNAL_ROWS = 100_000
const MAX_RECOVERY_EVENTS = 10_000
const MAX_RECOVERY_BYTES = 64 * 1024 * 1024
const MAX_EVENT_METADATA_BYTES = 64 * 1024 * 1024
const MAX_STATE_METADATA_BYTES = 64 * 1024 * 1024
const MAX_CLAIM_JSON_BYTES = 1024 * 1024
const MAX_COMPLETION_JSON_BYTES = 128 * 1024
const DATABASE_PAGE_ROWS = 128
const EVENT_METADATA_TOTALS_SQL = `SELECT COUNT(*) AS row_count, COALESCE(SUM(
  24 +
  length(CAST(event_key AS BLOB)) +
  length(CAST(provider AS BLOB)) +
  length(CAST(session_id AS BLOB)) +
  length(CAST(event_id AS BLOB)) +
  length(CAST(event_kind AS BLOB)) +
  length(CAST(occurred_at AS BLOB)) +
  COALESCE(length(CAST(stop_id AS BLOB)), 0) +
  COALESCE(length(CAST(worktree_path AS BLOB)), 0) +
  length(CAST(raw_sha256 AS BLOB))
), 0) AS metadata_bytes FROM events`

export class JournalCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalCorruptionError'
  }
}
export class JournalLockTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for the runtime journal transaction lock')
    this.name = 'JournalLockTimeoutError'
  }
}
export class ConflictingCaptureError extends Error {
  constructor(key: string) {
    super(`Capture identity was retried with different bytes or metadata: ${key}`)
    this.name = 'ConflictingCaptureError'
  }
}
export class ConflictingCompletionError extends Error {
  constructor(id: string) {
    super(`Materialization claim was completed with a different Turn: ${id}`)
    this.name = 'ConflictingCompletionError'
  }
}
export class JournalClosedError extends Error {
  constructor() {
    super('Runtime journal is closing or closed')
    this.name = 'JournalClosedError'
  }
}

export async function openRuntimeJournal(options: RuntimeJournalOptions): Promise<RuntimeJournal> {
  if (
    options.lockTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0)
  )
    throw new TypeError('lockTimeoutMs must be a positive finite integer')
  if ((options.repositoryRoot === undefined) === (options.testRuntimeRoot === undefined))
    throw new TypeError('Provide exactly one of repositoryRoot or testRuntimeRoot')
  const runtimeRoot = options.testRuntimeRoot
    ? await validateTestRuntimeRoot(options.testRuntimeRoot)
    : await locateGitCommonRuntime(options.repositoryRoot!)
  const root = join(runtimeRoot, 'journal-v1')
  const objects = join(root, 'objects', 'sha256')
  const temporary = join(root, 'tmp')
  const diagnostics = join(root, 'diagnostics')
  await ensurePrivateDirectory(root)
  await syncDirectory(root)
  await syncDirectory(runtimeRoot)
  for (const path of [dirname(objects), objects, temporary, diagnostics]) {
    await ensurePrivateDirectory(path)
    await syncDirectory(path)
    await syncDirectory(dirname(path))
  }
  const databasePath = join(root, 'journal.sqlite')
  await requireMissingOrPrivateFile(databasePath)
  await requireMissingOrPrivateFile(`${databasePath}-wal`)
  await requireMissingOrPrivateFile(`${databasePath}-shm`)
  const database = await openSqlite(databasePath)
  try {
    database.exec(`
    PRAGMA busy_timeout = ${Math.max(1, options.lockTimeoutMs ?? 5000)};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS journal_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), runtime_scope TEXT NOT NULL, next_sequence INTEGER NOT NULL CHECK(next_sequence>=0));
    CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, session_id TEXT NOT NULL, generation INTEGER NOT NULL, event_id TEXT NOT NULL, event_kind TEXT NOT NULL, occurred_at TEXT NOT NULL, stop_id TEXT, worktree_path TEXT, raw_sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, UNIQUE(provider, session_id, generation, stop_id));
    CREATE INDEX IF NOT EXISTS events_by_session_sequence ON events(provider, session_id, generation, sequence);
    CREATE TABLE IF NOT EXISTS claims(stop_key TEXT PRIMARY KEY, claim_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS completions(stop_key TEXT PRIMARY KEY, completion_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lifecycle_completions(event_key TEXT PRIMARY KEY, record_json TEXT NOT NULL);
    `)
    await requirePrivateFile(databasePath)
    await requireMissingOrPrivateFile(`${databasePath}-wal`)
    await requireMissingOrPrivateFile(`${databasePath}-shm`)
    verifyPragmas(database, options.lockTimeoutMs ?? 5000)
    const meta = stmt(database, 'SELECT runtime_scope FROM journal_meta WHERE singleton=1').get()
    if (meta == null)
      stmt(database, 'INSERT OR IGNORE INTO journal_meta VALUES(1, ?, 0)').run(
        `runtime_${randomUUID()}`,
      )
    const stored = record(
      stmt(database, 'SELECT runtime_scope FROM journal_meta WHERE singleton=1').get(),
      'runtime metadata',
    )
    if (typeof stored.runtime_scope !== 'string')
      throw new JournalCorruptionError('Runtime scope is malformed')
    await syncDirectory(root)
    const journal = new SqliteJournal(
      objects,
      temporary,
      diagnostics,
      stored.runtime_scope,
      database,
      options,
    )
    await journal.checkLogicalIntegrity()
    return journal
  } catch (error) {
    database.close()
    throw error
  }
}

class SqliteJournal implements RuntimeJournal {
  private transactionTail: Promise<void> = Promise.resolve()
  private lifecycle: 'open' | 'closing' | 'closed' = 'open'
  private activeOperations = 0
  private drained: (() => void)[] = []
  private closePromise?: Promise<void>

  constructor(
    private readonly objects: string,
    private readonly temporary: string,
    private readonly diagnostics: string,
    private readonly scope: string,
    private readonly db: Database,
    private readonly options: RuntimeJournalOptions,
  ) {}

  async checkLogicalIntegrity(): Promise<void> {
    await this.withOperation(() => this.transaction(undefined, () => this.assertLogicalIntegrity()))
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.lifecycle = 'closing'
    this.closePromise = (async () => {
      if (this.activeOperations > 0)
        await new Promise<void>(resolve => {
          this.drained.push(resolve)
        })
      await this.transactionTail
      this.db.close()
      this.lifecycle = 'closed'
    })()
    return this.closePromise
  }

  async append(input: RawCaptureInput): Promise<DurableCaptureReceipt> {
    return this.withOperation(() => this.appendUnchecked(input))
  }

  private async appendUnchecked(input: RawCaptureInput): Promise<DurableCaptureReceipt> {
    validateInput(input)
    const eventKey = identity(
      this.scope,
      input.provider,
      input.sessionId,
      String(input.generation),
      input.eventId,
    )
    const rawSha256 = digest(input.raw)
    await this.publishRaw(input.raw, rawSha256)
    const row = await this.transaction('journal', async () => {
      this.assertLogicalIntegrity()
      const existingValue = stmt(this.db, 'SELECT * FROM events WHERE event_key=?').get(eventKey)
      if (existingValue != null) {
        const existing = parseRow(existingValue)
        if (!sameCapture(existing, input, rawSha256)) throw new ConflictingCaptureError(eventKey)
        return existing
      }
      const meta = record(
        stmt(this.db, 'SELECT next_sequence FROM journal_meta WHERE singleton=1').get(),
        'runtime metadata',
      )
      if (!Number.isSafeInteger(meta.next_sequence))
        throw new JournalCorruptionError('Next sequence is malformed')
      const sequence = meta.next_sequence as number
      if (sequence >= MAX_JOURNAL_ROWS)
        throw new Error(`Journal reached its ${MAX_JOURNAL_ROWS} row bound`)
      stmt(this.db, `INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        sequence,
        eventKey,
        input.provider,
        input.sessionId,
        input.generation,
        input.eventId,
        input.eventKind,
        input.occurredAt,
        input.stopId ?? null,
        input.worktreePath ?? null,
        rawSha256,
        input.raw.byteLength,
      )
      const metadataBytes = numberField(
        record(stmt(this.db, EVENT_METADATA_TOTALS_SQL).get(), 'event metadata totals'),
        'metadata_bytes',
      )
      if (metadataBytes > MAX_EVENT_METADATA_BYTES)
        throw new Error(`Journal reached its ${MAX_EVENT_METADATA_BYTES} event metadata byte bound`)
      stmt(this.db, 'UPDATE journal_meta SET next_sequence=? WHERE singleton=1').run(sequence + 1)
      await this.boundary('journal-transaction-staged')
      return {
        sequence,
        eventKey,
        rawSha256,
        byteLength: input.raw.byteLength,
        provider: input.provider,
        sessionId: input.sessionId,
        generation: input.generation,
        eventId: input.eventId,
        eventKind: input.eventKind,
        occurredAt: input.occurredAt,
        ...(input.stopId === undefined ? {} : { stopId: input.stopId }),
        ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      } satisfies JournalRow
    })
    await this.boundary('journal-transaction-committed')
    await this.verifyRaw(row)
    return receipt(row)
  }

  async appendNonBlocking(input: RawCaptureInput): Promise<HookCaptureResult> {
    try {
      this.enterOperation()
    } catch {
      return {}
    }
    try {
      return { receipt: await this.appendUnchecked(input) }
    } catch (error) {
      try {
        const diagnosticId = await this.persistDiagnostic(error)
        return diagnosticId === undefined ? {} : { diagnosticId }
      } catch {
        return {}
      }
    } finally {
      this.leaveOperation()
    }
  }

  async recordDiagnostic(error: unknown): Promise<string | undefined> {
    try {
      return await this.persistDiagnostic(error)
    } catch {
      return undefined
    }
  }

  private async persistDiagnostic(error: unknown): Promise<string | undefined> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const messageBytes = new TextEncoder().encode(message)
    if (messageBytes.byteLength > 16 * 1024) return undefined
    const diagnosticId = digest(messageBytes)
    const path = join(this.diagnostics, `${diagnosticId}.txt`)
    try {
      const existing = await lstat(path)
      return existing.isFile() ? diagnosticId : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
    const directory = await opendir(this.diagnostics)
    let count = 0
    try {
      for await (const _entry of directory) {
        count += 1
        if (count >= MAX_DIAGNOSTICS) return undefined
      }
    } finally {
      try {
        await directory.close()
      } catch {
        // Async iteration closes the directory after exhaustion.
      }
    }
    const bytes = new TextEncoder().encode(`${new Date().toISOString()} ${message}\n`)
    try {
      await writeSynced(path, bytes)
      await syncDirectory(this.diagnostics)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return diagnosticId
  }

  async claimStop(stop: StopIdentity): Promise<ClaimStopResult> {
    return this.withOperation(async () => {
      validateStop(stop)
      const key = stopKey(stop)
      const result = await this.transaction('claim', async () => {
        this.assertLogicalIntegrity()
        const existing = stmt(this.db, 'SELECT claim_json FROM claims WHERE stop_key=?').get(key)
        if (existing != null)
          return {
            status: 'already-claimed' as const,
            claim: this.validateDurableClaim(
              parseClaim(record(existing, 'claim row').claim_json, stop),
            ),
          }
        const value = stmt(
          this.db,
          `SELECT * FROM events WHERE provider=? AND session_id=? AND generation=? AND event_kind='stop' AND stop_id=?`,
        ).get(stop.provider, stop.sessionId, stop.generation, stop.stopId)
        if (value == null)
          throw new Error(`Cannot claim a Stop that is not durably journaled: ${stop.stopId}`)
        const stopRow = parseRow(value)
        const priorStop = record(
          stmt(
            this.db,
            `SELECT MAX(sequence) AS sequence FROM events WHERE provider=? AND session_id=? AND generation=? AND event_kind='stop' AND sequence<?`,
          ).get(stop.provider, stop.sessionId, stop.generation, stopRow.sequence),
          'prior Stop row',
        )
        const priorSequence = priorStop.sequence == null ? -1 : numberField(priorStop, 'sequence')
        const turnRows = stmt(
          this.db,
          `SELECT event_key, byte_length FROM events WHERE provider=? AND session_id=? AND generation=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ${MAX_RECOVERY_EVENTS + 1}`,
        )
          .all(stop.provider, stop.sessionId, stop.generation, priorSequence, stopRow.sequence)
          .map(value => {
            const row = record(value, 'claim event row')
            const eventKey = stringField(row, 'event_key')
            const byteLength = numberField(row, 'byte_length')
            if (!SHA256.test(eventKey) || byteLength < 0 || byteLength > MAX_RAW_BYTES)
              throw new JournalCorruptionError('Claim event row is malformed')
            return { eventKey, byteLength }
          })
        if (turnRows.length > MAX_RECOVERY_EVENTS)
          throw new Error(`One Stop exceeds the ${MAX_RECOVERY_EVENTS} event recovery bound`)
        const rawBytes = turnRows.reduce((sum, row) => sum + row.byteLength, 0)
        if (!Number.isSafeInteger(rawBytes) || rawBytes > MAX_RECOVERY_BYTES)
          throw new Error(`One Stop exceeds the ${MAX_RECOVERY_BYTES} raw-byte recovery bound`)
        const eventKeys = turnRows.map(row => row.eventKey)
        const created: MaterializationClaim = {
          claimId: `claim_${identity(this.scope, key)}`,
          stop,
          claimedAt: new Date().toISOString(),
          throughSequence: stopRow.sequence,
          eventKeys,
        }
        const claimJson = encodeBoundedJson(created, MAX_CLAIM_JSON_BYTES, 'Claim')
        stmt(this.db, 'INSERT INTO claims VALUES(?,?)').run(key, claimJson)
        this.assertStateCapacity('claims', 'claim_json')
        await this.boundary('claim-transaction-staged')
        return { status: 'acquired' as const, claim: created }
      })
      await this.boundary('claim-transaction-committed')
      return result
    })
  }

  async complete(claim: MaterializationClaim, turn: RuntimeRecordRef): Promise<void> {
    await this.withOperation(async () => {
      validateStop(claim.stop)
      if (
        !claim.claimId ||
        !isOwnedTurnPath(turn.path) ||
        !SHA256.test(turn.sha256) ||
        !isAbsolute(turn.repositoryRoot) ||
        !/^repo_[A-Za-z0-9_-]+$/.test(turn.repositoryId)
      )
        throw new TypeError('Completion requires a valid claim and Turn reference')
      if (!this.options.verifyTurn)
        throw new Error('Completion requires the repository Turn-verification capability')
      const verifiedBytes = await this.options.verifyTurn(claim, turn)
      if (verifiedBytes.byteLength > MAX_RAW_BYTES || digest(verifiedBytes) !== turn.sha256)
        throw new JournalCorruptionError('Verified immutable Turn bytes do not match the reference')
      await this.transaction('completion', async () => {
        this.assertLogicalIntegrity()
        const key = stopKey(claim.stop)
        const claimRow = stmt(this.db, 'SELECT claim_json FROM claims WHERE stop_key=?').get(key)
        if (claimRow == null) throw new Error('Materialization claim is not durable')
        const durable = this.validateDurableClaim(
          parseClaim(record(claimRow, 'claim row').claim_json, claim.stop),
        )
        if (!sameJson(durable, claim)) throw new Error('Claim does not match the durable claim')
        const existingRow = stmt(
          this.db,
          'SELECT completion_json FROM completions WHERE stop_key=?',
        ).get(key)
        if (existingRow != null) {
          const existing = parseCompletion(record(existingRow, 'completion row').completion_json)
          if (existing.claimId !== claim.claimId || !sameJson(existing.turn, turn))
            throw new ConflictingCompletionError(claim.claimId)
          return
        }
        const completion: Completion = {
          claimId: claim.claimId,
          stop: claim.stop,
          turn,
          completedAt: new Date().toISOString(),
        }
        const completionJson = encodeBoundedJson(
          completion,
          MAX_COMPLETION_JSON_BYTES,
          'Completion',
        )
        stmt(this.db, 'INSERT INTO completions VALUES(?,?)').run(key, completionJson)
        this.assertStateCapacity('completions', 'completion_json')
        await this.boundary('completion-transaction-staged')
      })
      await this.boundary('completion-transaction-committed')
    })
  }

  async *recover(): AsyncIterable<RecoveryWork> {
    const recovered: RecoveryWork[] = []
    this.enterOperation()
    try {
      const snapshots = await this.transaction(undefined, () => this.collectRecovery())
      for (const snapshot of snapshots) {
        if (snapshot.limitation) {
          recovered.push({
            availability: 'unavailable',
            stop: snapshot.stop,
            ...(snapshot.claim ? { claim: snapshot.claim } : {}),
            events: [],
            limitation: snapshot.limitation,
          })
          continue
        }
        for (const candidate of snapshot.rows) await this.verifyRaw(candidate)
        recovered.push({
          availability: 'ready',
          stop: snapshot.stop,
          ...(snapshot.claim ? { claim: snapshot.claim } : {}),
          events: snapshot.rows.map(durableEvent),
        })
      }
    } finally {
      this.leaveOperation()
    }
    for (const work of recovered) yield work
  }

  async *recoverLifecycle(): AsyncIterable<DurableCaptureEvent> {
    const recovered = await this.withOperation(() =>
      this.transaction(undefined, () => {
        this.assertLogicalIntegrity()
        return this.readRows()
          .filter(row => row.eventKind === 'session-end')
          .filter(
            row =>
              stmt(this.db, 'SELECT 1 FROM lifecycle_completions WHERE event_key=?').get(
                row.eventKey,
              ) == null,
          )
          .map(durableEvent)
      }),
    )
    for (const event of recovered) yield event
  }

  async completeLifecycle(event: DurableCaptureEvent, reference: RuntimeRecordRef): Promise<void> {
    await this.withOperation(async () => {
      if (
        event.eventKind !== 'session-end' ||
        !/^sessions\/(codex|claude)\/[^/]+\/lifecycle\/[a-z][a-z0-9-]*_[0-7][0-9A-HJKMNP-TV-Z]{25}\.json$/.test(
          reference.path,
        ) ||
        !SHA256.test(reference.sha256) ||
        !isAbsolute(reference.repositoryRoot) ||
        !/^repo_[A-Za-z0-9_-]+$/.test(reference.repositoryId)
      )
        throw new TypeError('Lifecycle completion requires a SessionEnd lifecycle reference')
      const durableRow = stmt(this.db, 'SELECT * FROM events WHERE event_key=?').get(event.eventKey)
      if (durableRow == null || !sameJson(durableEvent(parseRow(durableRow)), event))
        throw new Error('Lifecycle event does not match a durable journal event')
      if (!this.options.verifyLifecycle)
        throw new Error('Lifecycle completion requires repository verification')
      const bytes = await this.options.verifyLifecycle(event, reference)
      if (digest(bytes) !== reference.sha256)
        throw new JournalCorruptionError('Verified lifecycle bytes do not match the reference')
      await this.transaction(undefined, async () => {
        const existing = stmt(
          this.db,
          'SELECT record_json FROM lifecycle_completions WHERE event_key=?',
        ).get(event.eventKey)
        const encoded = encodeBoundedJson(reference, MAX_COMPLETION_JSON_BYTES, 'Completion')
        if (existing != null) {
          if (stringField(record(existing, 'lifecycle completion'), 'record_json') !== encoded)
            throw new ConflictingCompletionError(event.eventKey)
          return
        }
        stmt(this.db, 'INSERT INTO lifecycle_completions VALUES(?,?)').run(event.eventKey, encoded)
        const totals = record(
          stmt(
            this.db,
            'SELECT COALESCE(SUM(length(CAST(event_key AS BLOB)) + length(CAST(record_json AS BLOB))), 0) AS metadata_bytes FROM lifecycle_completions',
          ).get(),
          'lifecycle completion totals',
        )
        if (numberField(totals, 'metadata_bytes') > MAX_STATE_METADATA_BYTES)
          throw new Error('lifecycle completion table reached its metadata byte bound')
        await this.boundary('lifecycle-completion-transaction-staged')
      })
      await this.boundary('lifecycle-completion-transaction-committed')
    })
  }

  private collectRecovery(): RecoverySnapshot[] {
    this.assertLogicalIntegrity()
    const rows = this.readRows()
    const ranges = buildClaimRanges(rows)
    const snapshots: RecoverySnapshot[] = []
    for (const row of rows.filter(row => row.eventKind === 'stop' && row.stopId)) {
      const stop = {
        provider: row.provider,
        sessionId: row.sessionId,
        generation: row.generation,
        stopId: row.stopId!,
      }
      const key = stopKey(stop)
      if (stmt(this.db, 'SELECT 1 FROM completions WHERE stop_key=?').get(key) != null) continue
      const claimRow = stmt(this.db, 'SELECT claim_json FROM claims WHERE stop_key=?').get(key)
      const claim =
        claimRow == null
          ? undefined
          : this.validateDurableClaim(
              parseClaim(record(claimRow, 'claim row').claim_json, stop),
              rows,
              ranges,
            )
      const selected = ranges.get(key)?.rows
      if (!selected) throw new JournalCorruptionError('Stop event has no recoverable range')
      if (
        claim &&
        (claim.throughSequence !== row.sequence ||
          !sameJson(
            claim.eventKeys,
            selected.map(candidate => candidate.eventKey),
          ))
      )
        throw new JournalCorruptionError('Claim cutoff does not match its Stop event range')
      const limitation = recoveryLimitation(selected)
      snapshots.push({
        stop,
        ...(claim ? { claim } : {}),
        rows: selected,
        ...(limitation ? { limitation } : {}),
      })
    }
    return snapshots
  }

  async readRaw(item: DurableCaptureReceipt): Promise<Uint8Array> {
    return this.withOperation(() => this.readRawUnchecked(item))
  }

  private async readRawUnchecked(item: DurableCaptureReceipt): Promise<Uint8Array> {
    if (
      !SHA256.test(item.rawSha256) ||
      !Number.isSafeInteger(item.byteLength) ||
      item.byteLength < 0 ||
      item.byteLength > MAX_RAW_BYTES
    )
      throw new TypeError('Raw receipt is invalid or exceeds the byte bound')
    await syncDirectory(this.objects)
    await syncDirectory(dirname(this.rawPath(item.rawSha256)))
    const bytes = await readNoFollow(this.rawPath(item.rawSha256), item.byteLength)
    if (bytes.byteLength !== item.byteLength || digest(bytes) !== item.rawSha256)
      throw new JournalCorruptionError(`Raw object does not match receipt: ${item.rawSha256}`)
    return bytes
  }

  async readClaimEvents(
    claim: MaterializationClaim,
  ): Promise<readonly { event: DurableCaptureEvent; raw: Uint8Array }[]> {
    return this.withOperation(async () => {
      const selected = await this.transaction(undefined, () => {
        this.assertLogicalIntegrity()
        const claimRow = stmt(this.db, 'SELECT claim_json FROM claims WHERE stop_key=?').get(
          stopKey(claim.stop),
        )
        if (claimRow == null) throw new Error('Materialization claim is not durable')
        const durable = this.validateDurableClaim(
          parseClaim(record(claimRow, 'claim row').claim_json, claim.stop),
        )
        if (!sameJson(durable, claim)) throw new Error('Claim does not match the durable claim')
        const rowsByKey = new Map(this.readRows().map(row => [row.eventKey, row]))
        const rows = durable.eventKeys.map(key => {
          const row = rowsByKey.get(key)
          if (!row) throw new JournalCorruptionError(`Claim event is missing: ${key}`)
          return row
        })
        assertRecoveryBounds(rows)
        return rows
      })
      const result: { event: DurableCaptureEvent; raw: Uint8Array }[] = []
      for (const row of selected)
        result.push({ event: durableEvent(row), raw: await this.readRawUnchecked(row) })
      return result
    })
  }

  async inventory(): Promise<{ referenced: string[]; orphaned: string[]; staging: string[] }> {
    return this.withOperation(async () => {
      await syncDirectory(this.objects)
      await syncDirectory(this.temporary)
      const referenced = await this.transaction(undefined, () => [
        ...new Set(this.readRows().map(row => row.rawSha256)),
      ])
      referenced.sort()
      const present: string[] = []
      for (const prefix of await readdir(this.objects).catch(() => [])) {
        await syncDirectory(join(this.objects, prefix))
        for (const suffix of await readdir(join(this.objects, prefix)).catch(() => []))
          if (SHA256.test(prefix + suffix)) present.push(prefix + suffix)
      }
      const staging = (await readdir(this.temporary).catch(() => [])).sort()
      return {
        referenced,
        orphaned: present.filter(value => !referenced.includes(value)).sort(),
        staging,
      }
    })
  }

  private readRows(): JournalRow[] {
    const totals = record(stmt(this.db, EVENT_METADATA_TOTALS_SQL).get(), 'event metadata totals')
    const rowCount = numberField(totals, 'row_count')
    const metadataBytes = numberField(totals, 'metadata_bytes')
    if (rowCount > MAX_JOURNAL_ROWS)
      throw new JournalCorruptionError(`Journal exceeds the ${MAX_JOURNAL_ROWS} row bound`)
    if (metadataBytes > MAX_EVENT_METADATA_BYTES)
      throw new JournalCorruptionError(
        `Journal exceeds the ${MAX_EVENT_METADATA_BYTES} event metadata byte bound`,
      )
    const rows: JournalRow[] = []
    let afterSequence = -1
    while (rows.length < rowCount) {
      const page = stmt(
        this.db,
        `SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ${DATABASE_PAGE_ROWS}`,
      )
        .all(afterSequence)
        .map(parseRow)
      if (page.length === 0)
        throw new JournalCorruptionError('Journal changed while its metadata was being read')
      for (const row of page) {
        if (row.sequence !== rows.length)
          throw new JournalCorruptionError(`Journal sequence is not contiguous at ${row.sequence}`)
        rows.push(row)
      }
      afterSequence = page.at(-1)!.sequence
    }
    if (rows.length !== rowCount)
      throw new JournalCorruptionError('Journal changed while its metadata was being read')
    return rows
  }
  private readStateRows(
    table: 'claims' | 'completions',
    jsonColumn: 'claim_json' | 'completion_json',
    maxJsonBytes: number,
  ): unknown[] {
    const totals = record(
      stmt(
        this.db,
        `SELECT COUNT(*) AS row_count, COALESCE(SUM(length(CAST(stop_key AS BLOB)) + length(CAST(${jsonColumn} AS BLOB))), 0) AS metadata_bytes FROM ${table}`,
      ).get(),
      `${table} metadata totals`,
    )
    const rowCount = numberField(totals, 'row_count')
    const metadataBytes = numberField(totals, 'metadata_bytes')
    if (rowCount > MAX_JOURNAL_ROWS)
      throw new JournalCorruptionError(`${table} table exceeds the journal row bound`)
    if (metadataBytes > MAX_STATE_METADATA_BYTES)
      throw new JournalCorruptionError(
        `${table} table exceeds the ${MAX_STATE_METADATA_BYTES} metadata byte bound`,
      )
    const rows: Record<string, unknown>[] = []
    let afterKey = ''
    while (rows.length < rowCount) {
      const page = stmt(
        this.db,
        `SELECT
          CASE WHEN length(CAST(stop_key AS BLOB))=64 THEN stop_key END AS stop_key,
          length(CAST(stop_key AS BLOB)) AS stop_key_bytes,
          CASE WHEN length(CAST(${jsonColumn} AS BLOB))<=${maxJsonBytes} THEN ${jsonColumn} END AS ${jsonColumn},
          length(CAST(${jsonColumn} AS BLOB)) AS json_bytes
        FROM ${table} WHERE stop_key>? ORDER BY stop_key LIMIT ${DATABASE_PAGE_ROWS}`,
      ).all(afterKey)
      if (page.length === 0)
        throw new JournalCorruptionError(`${table} changed while its metadata was being read`)
      for (const value of page) {
        const stored = record(value, `${table} row`)
        if (numberField(stored, 'stop_key_bytes') !== 64)
          throw new JournalCorruptionError(`${table} row key exceeds its byte bound`)
        const jsonBytes = numberField(stored, 'json_bytes')
        if (jsonBytes > maxJsonBytes)
          throw new JournalCorruptionError(
            `${table === 'claims' ? 'Claim' : 'Completion'} JSON exceeds its byte bound`,
          )
        const key = stringField(stored, 'stop_key')
        rows.push({ stop_key: key, [jsonColumn]: stored[jsonColumn] })
        afterKey = key
      }
    }
    if (rows.length !== rowCount)
      throw new JournalCorruptionError(`${table} changed while its metadata was being read`)
    return rows
  }
  private assertStateCapacity(
    table: 'claims' | 'completions',
    jsonColumn: 'claim_json' | 'completion_json',
  ): void {
    const totals = record(
      stmt(
        this.db,
        `SELECT COALESCE(SUM(length(CAST(stop_key AS BLOB)) + length(CAST(${jsonColumn} AS BLOB))), 0) AS metadata_bytes FROM ${table}`,
      ).get(),
      `${table} metadata totals`,
    )
    if (numberField(totals, 'metadata_bytes') > MAX_STATE_METADATA_BYTES)
      throw new Error(`${table} table reached its metadata byte bound`)
  }
  assertLogicalIntegrity(): void {
    const result = record(stmt(this.db, 'PRAGMA integrity_check').get(), 'integrity result')
    if (Object.values(result)[0] !== 'ok')
      throw new JournalCorruptionError(
        `SQLite integrity check failed: ${String(Object.values(result)[0])}`,
      )
    const rows = this.readRows()
    const meta = record(
      stmt(this.db, 'SELECT next_sequence FROM journal_meta WHERE singleton=1').get(),
      'runtime metadata',
    )
    if (meta.next_sequence !== rows.length)
      throw new JournalCorruptionError('Next sequence does not match the contiguous journal')
    for (const row of rows) {
      const expected = identity(
        this.scope,
        row.provider,
        row.sessionId,
        String(row.generation),
        row.eventId,
      )
      if (row.eventKey !== expected)
        throw new JournalCorruptionError(
          `Event identity does not match its durable row: ${row.sequence}`,
        )
    }
    const claimRows = this.readStateRows('claims', 'claim_json', MAX_CLAIM_JSON_BYTES)
    const claimRanges = buildClaimRanges(rows)
    const claims = new Map<string, MaterializationClaim>()
    for (const value of claimRows) {
      const stored = record(value, 'claim row')
      const key = stringField(stored, 'stop_key')
      const claim = parseStoredClaim(stored.claim_json)
      if (key !== stopKey(claim.stop))
        throw new JournalCorruptionError('Claim row key does not match its Stop identity')
      this.validateDurableClaim(claim, rows, claimRanges)
      claims.set(key, claim)
    }
    const completionRows = this.readStateRows(
      'completions',
      'completion_json',
      MAX_COMPLETION_JSON_BYTES,
    )
    for (const value of completionRows) {
      const stored = record(value, 'completion row')
      const key = stringField(stored, 'stop_key')
      const completion = parseCompletion(stored.completion_json)
      validateStopAsCorruption(completion.stop)
      const claim = claims.get(key)
      if (
        key !== stopKey(completion.stop) ||
        !claim ||
        completion.claimId !== claim.claimId ||
        !sameJson(completion.stop, claim.stop)
      )
        throw new JournalCorruptionError('Completion does not match its durable claim')
    }
    const lifecycleTotals = record(
      stmt(
        this.db,
        'SELECT COUNT(*) AS row_count, COALESCE(SUM(length(CAST(event_key AS BLOB)) + length(CAST(record_json AS BLOB))), 0) AS metadata_bytes FROM lifecycle_completions',
      ).get(),
      'lifecycle completion totals',
    )
    if (
      numberField(lifecycleTotals, 'row_count') > MAX_JOURNAL_ROWS ||
      numberField(lifecycleTotals, 'metadata_bytes') > MAX_STATE_METADATA_BYTES
    )
      throw new JournalCorruptionError('lifecycle completion table exceeds its bounds')
    const lifecycleRows = stmt(
      this.db,
      `SELECT event_key, CASE WHEN length(CAST(record_json AS BLOB))<=${MAX_COMPLETION_JSON_BYTES} THEN record_json END AS record_json, length(CAST(record_json AS BLOB)) AS json_bytes FROM lifecycle_completions ORDER BY event_key LIMIT ${MAX_JOURNAL_ROWS + 1}`,
    ).all()
    if (lifecycleRows.length !== numberField(lifecycleTotals, 'row_count'))
      throw new JournalCorruptionError('lifecycle completion rows are inconsistent')
    const events = new Map(rows.map(row => [row.eventKey, row]))
    for (const value of lifecycleRows) {
      const stored = record(value, 'lifecycle completion row')
      const key = stringField(stored, 'event_key')
      if (!SHA256.test(key) || numberField(stored, 'json_bytes') > MAX_COMPLETION_JSON_BYTES)
        throw new JournalCorruptionError('lifecycle completion row exceeds its bounds')
      const event = events.get(key)
      if (event?.eventKind !== 'session-end')
        throw new JournalCorruptionError('lifecycle completion does not reference SessionEnd')
      const reference = record(
        JSON.parse(stringField(stored, 'record_json')),
        'lifecycle completion reference',
      )
      if (
        !sameJson(Object.keys(reference).sort(), [
          'path',
          'repositoryId',
          'repositoryRoot',
          'sha256',
        ]) ||
        typeof reference.path !== 'string' ||
        !/^sessions\/(codex|claude)\/[^/]+\/lifecycle\/[a-z][a-z0-9-]*_[0-7][0-9A-HJKMNP-TV-Z]{25}\.json$/.test(
          reference.path,
        ) ||
        typeof reference.sha256 !== 'string' ||
        !SHA256.test(reference.sha256) ||
        typeof reference.repositoryRoot !== 'string' ||
        !isAbsolute(reference.repositoryRoot) ||
        typeof reference.repositoryId !== 'string' ||
        !/^repo_[A-Za-z0-9_-]+$/.test(reference.repositoryId)
      )
        throw new JournalCorruptionError('lifecycle completion reference is malformed')
    }
  }
  private async publishRaw(bytes: Uint8Array, sha: string): Promise<void> {
    const directory = join(this.objects, sha.slice(0, 2))
    const destination = this.rawPath(sha)
    await syncDirectory(this.objects)
    await syncDirectory(this.temporary)
    await ensurePrivateDirectory(directory)
    await syncDirectory(directory)
    await syncDirectory(this.objects)
    const existing = await readBytes(destination)
    if (existing) {
      if (digest(existing) !== sha || !equalBytes(existing, bytes))
        throw new JournalCorruptionError(`Existing raw object is corrupt: ${sha}`)
      await syncDirectory(directory)
      await this.boundary('raw-directory-synced')
      return
    }
    const temporary = join(this.temporary, `${randomUUID()}.raw`)
    try {
      await writeSynced(temporary, bytes)
      await this.boundary('raw-file-synced')
      try {
        await link(temporary, destination)
        await this.boundary('raw-published')
        await syncDirectory(directory)
        await this.boundary('raw-directory-synced')
      } catch (error) {
        if (!isCode(error, 'EEXIST')) throw error
        const competing = await readBytes(destination)
        if (!competing || !equalBytes(competing, bytes))
          throw new JournalCorruptionError(`Concurrent raw object differs: ${sha}`)
        await syncDirectory(directory)
        await this.boundary('raw-directory-synced')
      }
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
  private async verifyRaw(row: JournalRow): Promise<void> {
    await this.readRawUnchecked(row)
  }
  private validateDurableClaim(
    claim: MaterializationClaim,
    rows = this.readRows(),
    ranges = buildClaimRanges(rows),
  ): MaterializationClaim {
    const expectedClaimId = `claim_${identity(this.scope, stopKey(claim.stop))}`
    if (claim.claimId !== expectedClaimId || !isStrictTimestamp(claim.claimedAt))
      throw new JournalCorruptionError('Claim identity or timestamp is invalid')
    const range = ranges.get(stopKey(claim.stop))
    const stopRow = range?.stopRow
    if (!stopRow || claim.throughSequence !== stopRow.sequence)
      throw new JournalCorruptionError('Claim cutoff does not match its durable Stop')
    const expectedKeys = range.rows.map(row => row.eventKey)
    if (!sameJson(claim.eventKeys, expectedKeys))
      throw new JournalCorruptionError('Claim event range does not match durable rows')
    return claim
  }
  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.enterOperation()
    try {
      return await operation()
    } finally {
      this.leaveOperation()
    }
  }
  private enterOperation(): void {
    if (this.lifecycle !== 'open') throw new JournalClosedError()
    this.activeOperations += 1
  }
  private leaveOperation(): void {
    this.activeOperations -= 1
    if (this.activeOperations === 0) {
      for (const resolve of this.drained.splice(0)) resolve()
    }
  }
  private async transaction<T>(
    kind: 'journal' | 'claim' | 'completion' | undefined,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const prior = this.transactionTail
    let release = () => {}
    this.transactionTail = new Promise<void>(resolve => {
      release = resolve
    })
    await prior
    try {
      return await this.runTransaction(kind, operation)
    } finally {
      release()
    }
  }
  private async runTransaction<T>(
    kind: 'journal' | 'claim' | 'completion' | undefined,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + (this.options.lockTimeoutMs ?? 5000)
    while (true) {
      try {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          const result = await operation()
          if (kind) await this.boundary(`${kind}-commit-attempt`)
          this.db.exec('COMMIT')
          return result
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
      } catch (error) {
        if (!isBusy(error)) throw error
        if (Date.now() >= deadline) throw new JournalLockTimeoutError()
        await delay(5)
      }
    }
  }
  private async boundary(value: DurabilityBoundary): Promise<void> {
    await this.options.onDurabilityBoundary?.(value)
  }
  private rawPath(sha: string): string {
    if (!SHA256.test(sha)) throw new TypeError('Invalid raw SHA-256')
    return join(this.objects, sha.slice(0, 2), sha.slice(2))
  }
}

async function openSqlite(path: string): Promise<Database> {
  if ('Bun' in globalThis) {
    const name = 'bun:sqlite'
    const module = (await import(name)) as {
      Database: new (path: string, options: unknown) => Database
    }
    return new module.Database(path, { create: true, strict: true })
  }
  const name = 'node:sqlite'
  const module = (await import(name)) as { DatabaseSync: new (path: string) => Database }
  return new module.DatabaseSync(path)
}
function stmt(database: Database, sql: string): Statement {
  const value = database.prepare?.(sql) ?? database.query?.(sql)
  if (!value) throw new Error('SQLite prepared statements unavailable')
  return value
}
function validateInput(input: RawCaptureInput): void {
  if (
    !['codex', 'claude'].includes(input.provider) ||
    !EVENT_KINDS.includes(input.eventKind) ||
    !boundedText(input.sessionId, MAX_IDENTIFIER_BYTES) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    !boundedText(input.eventId, MAX_IDENTIFIER_BYTES) ||
    !isStrictTimestamp(input.occurredAt) ||
    !(input.raw instanceof Uint8Array) ||
    input.raw.byteLength > MAX_RAW_BYTES ||
    (input.stopId !== undefined && !boundedText(input.stopId, MAX_IDENTIFIER_BYTES)) ||
    (input.worktreePath !== undefined &&
      (!isAbsolute(input.worktreePath) || !boundedText(input.worktreePath, MAX_PATH_BYTES)))
  )
    throw new TypeError('Capture input contains an unsupported or oversized provider event')
  if (input.eventKind === 'stop' && !input.stopId) throw new TypeError('Stop events require stopId')
  if (input.eventKind !== 'stop' && input.stopId !== undefined)
    throw new TypeError('Only Stop events may carry stopId')
}
function validateStop(stop: StopIdentity): void {
  if (
    !['codex', 'claude'].includes(stop.provider) ||
    !boundedText(stop.sessionId, MAX_IDENTIFIER_BYTES) ||
    !Number.isSafeInteger(stop.generation) ||
    stop.generation < 0 ||
    !boundedText(stop.stopId, MAX_IDENTIFIER_BYTES)
  )
    throw new TypeError('Stop identity is incomplete')
}
function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    isWellFormedText(value) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  )
}

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}
function parseRow(value: unknown): JournalRow {
  const row = record(value, 'journal row')
  const parsed: JournalRow = {
    sequence: numberField(row, 'sequence'),
    eventKey: stringField(row, 'event_key'),
    provider: stringField(row, 'provider') as CaptureProvider,
    sessionId: stringField(row, 'session_id'),
    generation: numberField(row, 'generation'),
    eventId: stringField(row, 'event_id'),
    eventKind: stringField(row, 'event_kind') as CaptureEventKind,
    occurredAt: stringField(row, 'occurred_at'),
    rawSha256: stringField(row, 'raw_sha256'),
    byteLength: numberField(row, 'byte_length'),
    ...(row.stop_id == null ? {} : { stopId: stringField(row, 'stop_id') }),
    ...(row.worktree_path == null ? {} : { worktreePath: stringField(row, 'worktree_path') }),
  }
  if (
    parsed.sequence < 0 ||
    !SHA256.test(parsed.eventKey) ||
    !SHA256.test(parsed.rawSha256) ||
    parsed.byteLength < 0 ||
    parsed.byteLength > MAX_RAW_BYTES ||
    !isStrictTimestamp(parsed.occurredAt) ||
    !boundedText(parsed.sessionId, MAX_IDENTIFIER_BYTES) ||
    !boundedText(parsed.eventId, MAX_IDENTIFIER_BYTES) ||
    (parsed.stopId !== undefined && !boundedText(parsed.stopId, MAX_IDENTIFIER_BYTES)) ||
    (parsed.worktreePath !== undefined &&
      (!isAbsolute(parsed.worktreePath) || !boundedText(parsed.worktreePath, MAX_PATH_BYTES))) ||
    !['codex', 'claude'].includes(parsed.provider) ||
    !EVENT_KINDS.includes(parsed.eventKind) ||
    (parsed.eventKind === 'stop' && !parsed.stopId) ||
    (parsed.eventKind !== 'stop' && parsed.stopId !== undefined)
  )
    throw new JournalCorruptionError('Journal row contains invalid values')
  return parsed
}
function parseClaim(value: unknown, stop: StopIdentity): MaterializationClaim {
  assertBoundedJson(value, MAX_CLAIM_JSON_BYTES, 'Claim')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new JournalCorruptionError('Claim JSON is malformed')
  }
  const claim = record(parsed, 'claim')
  if (
    !sameJson(Object.keys(claim).sort(), [
      'claimId',
      'claimedAt',
      'eventKeys',
      'stop',
      'throughSequence',
    ]) ||
    typeof claim.claimId !== 'string' ||
    typeof claim.claimedAt !== 'string' ||
    !Number.isSafeInteger(claim.throughSequence) ||
    (claim.throughSequence as number) < 0 ||
    !Array.isArray(claim.eventKeys) ||
    !claim.eventKeys.every(key => typeof key === 'string' && SHA256.test(key)) ||
    !sameJson(claim.stop, stop)
  )
    throw new JournalCorruptionError('Claim is malformed or names a different Stop')
  return claim as unknown as MaterializationClaim
}
function parseStoredClaim(value: unknown): MaterializationClaim {
  assertBoundedJson(value, MAX_CLAIM_JSON_BYTES, 'Claim')
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new JournalCorruptionError('Claim JSON is malformed')
  }
  const rawStop = record(record(decoded, 'claim').stop, 'claim Stop')
  const stop = {
    provider: stringField(rawStop, 'provider') as CaptureProvider,
    sessionId: stringField(rawStop, 'sessionId'),
    generation: numberField(rawStop, 'generation'),
    stopId: stringField(rawStop, 'stopId'),
  }
  validateStopAsCorruption(stop)
  return parseClaim(value, stop)
}
function parseCompletion(value: unknown): Completion {
  assertBoundedJson(value, MAX_COMPLETION_JSON_BYTES, 'Completion')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new JournalCorruptionError('Completion JSON is malformed')
  }
  const completion = record(parsed, 'completion')
  const turn = record(completion.turn, 'Turn reference')
  if (
    !sameJson(Object.keys(completion).sort(), ['claimId', 'completedAt', 'stop', 'turn']) ||
    !sameJson(Object.keys(turn).sort(), ['path', 'repositoryId', 'repositoryRoot', 'sha256']) ||
    typeof completion.claimId !== 'string' ||
    typeof completion.completedAt !== 'string' ||
    !isObject(completion.stop) ||
    typeof turn.path !== 'string' ||
    !isOwnedTurnPath(turn.path) ||
    typeof turn.sha256 !== 'string' ||
    !SHA256.test(turn.sha256) ||
    typeof turn.repositoryRoot !== 'string' ||
    !isAbsolute(turn.repositoryRoot) ||
    typeof turn.repositoryId !== 'string' ||
    !/^repo_[A-Za-z0-9_-]+$/.test(turn.repositoryId) ||
    !isStrictTimestamp(String(completion.completedAt))
  )
    throw new JournalCorruptionError('Completion is malformed')
  return completion as unknown as Completion
}
function validateStopAsCorruption(stop: StopIdentity): void {
  try {
    validateStop(stop)
  } catch {
    throw new JournalCorruptionError('Stored Stop identity is malformed')
  }
}
function assertBoundedJson(
  value: unknown,
  maxBytes: number,
  label: 'Claim' | 'Completion',
): asserts value is string {
  if (typeof value !== 'string') throw new JournalCorruptionError(`${label} JSON is missing`)
  if (value.length > maxBytes || new TextEncoder().encode(value).byteLength > maxBytes)
    throw new JournalCorruptionError(`${label} JSON exceeds its byte bound`)
}
function encodeBoundedJson(
  value: unknown,
  maxBytes: number,
  label: 'Claim' | 'Completion',
): string {
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > maxBytes)
    throw new Error(`${label} JSON exceeds its byte bound`)
  return encoded
}
function sameCapture(row: JournalRow, input: RawCaptureInput, sha: string): boolean {
  return (
    row.provider === input.provider &&
    row.sessionId === input.sessionId &&
    row.generation === input.generation &&
    row.eventId === input.eventId &&
    row.eventKind === input.eventKind &&
    row.stopId === input.stopId &&
    row.worktreePath === input.worktreePath &&
    row.rawSha256 === sha &&
    row.byteLength === input.raw.byteLength
  )
}
function receipt(row: JournalRow): DurableCaptureReceipt {
  return {
    sequence: row.sequence,
    eventKey: row.eventKey,
    rawSha256: row.rawSha256,
    byteLength: row.byteLength,
  }
}
function durableEvent(row: JournalRow): DurableCaptureEvent {
  return {
    ...receipt(row),
    provider: row.provider,
    sessionId: row.sessionId,
    generation: row.generation,
    eventId: row.eventId,
    eventKind: row.eventKind,
    occurredAt: row.occurredAt,
    ...(row.stopId === undefined ? {} : { stopId: row.stopId }),
    ...(row.worktreePath === undefined ? {} : { worktreePath: row.worktreePath }),
  }
}
function buildClaimRanges(rows: readonly JournalRow[]): Map<string, ClaimRange> {
  const pending = new Map<string, JournalRow[]>()
  const ranges = new Map<string, ClaimRange>()
  for (const row of rows) {
    const session = identity(row.provider, row.sessionId, String(row.generation))
    const current = pending.get(session) ?? []
    current.push(row)
    if (row.eventKind === 'stop' && row.stopId) {
      const stop = {
        provider: row.provider,
        sessionId: row.sessionId,
        generation: row.generation,
        stopId: row.stopId,
      }
      ranges.set(stopKey(stop), { stopRow: row, rows: current })
      pending.set(session, [])
    } else pending.set(session, current)
  }
  return ranges
}
function assertRecoveryBounds(rows: readonly JournalRow[]): void {
  const limitation = recoveryLimitation(rows)
  if (limitation)
    throw new JournalCorruptionError(
      `Recovery exceeds ${limitation.limit} ${limitation.kind === 'event-count' ? 'events' : 'raw bytes'}`,
    )
}
function recoveryLimitation(rows: readonly JournalRow[]): RecoveryLimitation | undefined {
  if (rows.length > MAX_RECOVERY_EVENTS)
    return { kind: 'event-count', limit: MAX_RECOVERY_EVENTS, observed: rows.length }
  const rawBytes = rows.reduce((sum, row) => sum + row.byteLength, 0)
  if (!Number.isSafeInteger(rawBytes) || rawBytes > MAX_RECOVERY_BYTES)
    return { kind: 'raw-bytes', limit: MAX_RECOVERY_BYTES, observed: rawBytes }
  return undefined
}
function identity(...parts: string[]): string {
  return digest(new TextEncoder().encode(parts.map(part => `${part.length}:${part}`).join('|')))
}
function stopKey(stop: StopIdentity): string {
  return identity(stop.provider, stop.sessionId, String(stop.generation), stop.stopId)
}
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
async function writeSynced(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function readBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readNoFollow(path, MAX_RAW_BYTES)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined
    throw error
  }
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new JournalCorruptionError(`${label} is not an object`)
  return value
}
function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw new JournalCorruptionError(`${key} is not a string`)
  return field
}
function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (!Number.isSafeInteger(field)) throw new JournalCorruptionError(`${key} is not an integer`)
  return field as number
}
function isBusy(error: unknown): boolean {
  return (
    isObject(error) &&
    (error.code === 'SQLITE_BUSY' || String(error.message).includes('database is locked'))
  )
}
function isCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function isStrictTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z')
  return new Date(parsed).toISOString() === normalized
}

function isOwnedTurnPath(path: string): path is OwnedPath {
  if (!boundedText(path, MAX_PATH_BYTES)) return false
  const parts = path.split('/')
  if (
    parts.length !== 6 ||
    parts[0] !== 'sessions' ||
    !['codex', 'claude'].includes(parts[1] ?? '') ||
    parts[3] !== 'turns' ||
    parts[5] !== 'manifest.json'
  )
    return false
  return parts.slice(1).every(isSafeOwnedSegment)
}

function isSafeOwnedSegment(segment: string): boolean {
  return (
    boundedText(segment, MAX_IDENTIFIER_BYTES) &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('\\') &&
    !segment.includes('\0') &&
    isWellFormedText(segment)
  )
}

async function validateTestRuntimeRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new TypeError('testRuntimeRoot must be absolute')
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new TypeError('testRuntimeRoot must be an existing ordinary directory')
  await chmod(path, 0o700)
  return path
}

/** Resolve the private runtime root shared by every worktree of one Git repository. */
export async function locateGitCommonRuntime(repositoryRoot: string): Promise<string> {
  if (!isAbsolute(repositoryRoot)) throw new TypeError('repositoryRoot must be absolute')
  const worktree = await realpath(repositoryRoot)
  const dotGit = join(worktree, '.git')
  const gitInfo = await lstat(dotGit)
  let gitDirectory: string
  if (gitInfo.isDirectory() && !gitInfo.isSymbolicLink()) {
    gitDirectory = await realpath(dotGit)
  } else if (gitInfo.isFile() && !gitInfo.isSymbolicLink()) {
    const marker = new TextDecoder('utf-8', { fatal: true })
      .decode(await readNoFollow(dotGit))
      .trim()
    const match = /^gitdir: (.+)$/.exec(marker)
    if (!match?.[1]) throw new Error('Invalid linked-worktree .git file')
    gitDirectory = await realpath(resolve(worktree, match[1]))
  } else {
    throw new Error('Factory runtime journal requires ordinary Git metadata')
  }
  const commonMarker = join(gitDirectory, 'commondir')
  let commonDirectory = gitDirectory
  try {
    const markerInfo = await lstat(commonMarker)
    if (markerInfo.isSymbolicLink() || !markerInfo.isFile())
      throw new Error('Factory refuses a non-file Git commondir marker')
    const marker = new TextDecoder('utf-8', { fatal: true })
      .decode(await readNoFollow(commonMarker))
      .trim()
    commonDirectory = await realpath(resolve(gitDirectory, marker))
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
  const commonInfo = await lstat(commonDirectory)
  if (commonInfo.isSymbolicLink() || !commonInfo.isDirectory())
    throw new Error('Factory requires an ordinary Git common directory')
  const runtimeRoot = join(commonDirectory, 'factory-runtime')
  await ensurePrivateDirectory(runtimeRoot)
  await syncDirectory(runtimeRoot)
  await syncDirectory(commonDirectory)
  return runtimeRoot
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error
  }
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new JournalCorruptionError(`Runtime path is not an ordinary directory: ${path}`)
  await chmod(path, 0o700)
}

async function requireMissingOrPrivateFile(path: string): Promise<void> {
  try {
    await requirePrivateFile(path)
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
}

async function requirePrivateFile(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile())
    throw new JournalCorruptionError(`Runtime path is not an ordinary file: ${path}`)
  await chmod(path, 0o600)
}

async function readNoFollow(path: string, maxBytes = MAX_PATH_BYTES): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new JournalCorruptionError(`Runtime path is not a file: ${path}`)
    if (info.size > maxBytes)
      throw new JournalCorruptionError(`Runtime file exceeds its byte bound: ${path}`)
    const bytes = new Uint8Array(info.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) throw new JournalCorruptionError(`Runtime file was truncated: ${path}`)
      offset += bytesRead
    }
    const extra = new Uint8Array(1)
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0)
      throw new JournalCorruptionError(`Runtime file grew beyond its byte bound: ${path}`)
    return bytes
  } finally {
    await handle.close()
  }
}

function verifyPragmas(database: Database, lockTimeoutMs: number): void {
  const journalMode = Object.values(
    record(stmt(database, 'PRAGMA journal_mode').get(), 'journal mode'),
  )[0]
  const synchronous = Object.values(
    record(stmt(database, 'PRAGMA synchronous').get(), 'synchronous mode'),
  )[0]
  const foreignKeys = Object.values(
    record(stmt(database, 'PRAGMA foreign_keys').get(), 'foreign keys'),
  )[0]
  const busyTimeout = Object.values(
    record(stmt(database, 'PRAGMA busy_timeout').get(), 'busy timeout'),
  )[0]
  if (
    String(journalMode).toLowerCase() !== 'wal' ||
    Number(synchronous) !== 2 ||
    Number(foreignKeys) !== 1 ||
    Number(busyTimeout) !== lockTimeoutMs
  )
    throw new Error('SQLite refused the required WAL, FULL synchronous, or foreign-key settings')
}
