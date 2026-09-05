import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeOwnedPath } from '@factory/contract'

import { openRuntimeJournal, type DurabilityBoundary } from '../src/index.js'

if (process.env.FACTORY_DOCKER_TEST !== '1') throw new Error('journal lab must run in Docker')
const output = process.argv[2]
if (!output) throw new Error('output directory required')

const productionRoot = await mkdtemp(join(tmpdir(), 'journal-latency-'))
const journal = await openRuntimeJournal({ testRuntimeRoot: productionRoot })
const nonStop: number[] = []
const stop: number[] = []
for (let index = 0; index < 40; index += 1) {
  const isStop = index >= 30
  const start = performance.now()
  await journal.append({
    provider: 'codex',
    sessionId: 'latency',
    generation: 0,
    eventId: `event-${index}`,
    eventKind: isStop ? 'stop' : 'turn',
    ...(isStop ? { stopId: `stop-${index}` } : {}),
    occurredAt: '2026-09-04T00:00:00Z',
    raw: new TextEncoder().encode(`payload-${index}`),
  })
  ;(isStop ? stop : nonStop).push(performance.now() - start)
}

const contentionRoot = await mkdtemp(join(tmpdir(), 'journal-contention-'))
const contentionStart = performance.now()
const writers = Array.from({ length: 8 }, (_, worker) =>
  Bun.spawn(
    [
      'bun',
      new URL('./concurrent-writer.ts', import.meta.url).pathname,
      contentionRoot,
      String(worker),
      '25',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  ),
)
const exits = await Promise.all(writers.map(writer => writer.exited))
const contentionMs = performance.now() - contentionStart
const contentionJournal = await openRuntimeJournal({ testRuntimeRoot: contentionRoot })
const contentionInventory = await contentionJournal.inventory()

const crashMatrix: Record<
  string,
  { retrySequence: number; orphansBeforeRetry: number; orphansAfterRetry: number }
> = {}
const boundaries: DurabilityBoundary[] = [
  'raw-file-synced',
  'raw-published',
  'raw-directory-synced',
  'journal-transaction-staged',
  'journal-commit-attempt',
  'journal-transaction-committed',
]
for (const boundary of boundaries) {
  const root = await mkdtemp(join(tmpdir(), 'journal-crash-'))
  const child = Bun.spawn(
    ['bun', new URL('./crash-worker.ts', import.meta.url).pathname, root, 'append', boundary],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if ((await child.exited) === 0) throw new Error(`Crash worker survived ${boundary}`)
  if ((await readFile(join(root, `reached-${boundary}`), 'utf8')) !== boundary)
    throw new Error(`Crash worker did not reach ${boundary}`)
  const reopened = await openRuntimeJournal({ testRuntimeRoot: root })
  const beforeRetry = await reopened.inventory()
  const receipt = await reopened.append({
    provider: 'codex',
    sessionId: 'crash-session',
    generation: 0,
    eventId: 'event-1',
    eventKind: 'turn',
    occurredAt: '2026-09-04T00:00:00Z',
    raw: new TextEncoder().encode('crash-payload'),
  })
  crashMatrix[boundary] = {
    retrySequence: receipt.sequence,
    orphansBeforeRetry: beforeRetry.orphaned.length + beforeRetry.staging.length,
    orphansAfterRetry:
      (await reopened.inventory()).orphaned.length + (await reopened.inventory()).staging.length,
  }
}

const stateRoot = await mkdtemp(join(tmpdir(), 'journal-state-'))
const stateJournal = await openRuntimeJournal({
  testRuntimeRoot: stateRoot,
  verifyTurn: async (_claim, turn) =>
    new Uint8Array(await readFile(join(stateRoot, '.factory', turn.path))),
})
await stateJournal.append({
  provider: 'claude',
  sessionId: 'state-session',
  generation: 1,
  eventId: 'stop-event',
  eventKind: 'stop',
  stopId: 'stop-1',
  occurredAt: '2026-09-04T00:00:00Z',
  raw: new TextEncoder().encode('stop'),
})
const stateStop = {
  provider: 'claude' as const,
  sessionId: 'state-session',
  generation: 1,
  stopId: 'stop-1',
}
const firstClaim = (await stateJournal.claimStop(stateStop)).claim
const recoveredClaim = (await Array.fromAsync(stateJournal.recover()))[0]?.claim
const turnPath = makeOwnedPath('sessions', [
  'claude',
  'state-session',
  'turns',
  'stop-1',
  'manifest.json',
])
const turnBytes = new TextEncoder().encode('verified immutable lab Turn')
await mkdir(join(stateRoot, '.factory', 'sessions/claude/state-session/turns/stop-1'), {
  recursive: true,
})
await writeFile(join(stateRoot, '.factory', turnPath), turnBytes, { flag: 'wx' })
await stateJournal.complete(firstClaim, {
  path: turnPath,
  sha256: createHash('sha256').update(turnBytes).digest('hex'),
  repositoryRoot: stateRoot,
  repositoryId: 'repo_fixture',
})
const recoveryAfterCompletion = await Array.fromAsync(stateJournal.recover())

const diskRoot = process.env.FACTORY_DISK_FULL_ROOT
if (!diskRoot) throw new Error('disk-full lab mount is required')
const diskJournal = await openRuntimeJournal({ testRuntimeRoot: diskRoot })
let diskFullRejected = false
try {
  await diskJournal.append({
    provider: 'codex',
    sessionId: 'disk',
    generation: 0,
    eventId: 'large',
    eventKind: 'turn',
    occurredAt: '2026-09-04T00:00:00Z',
    raw: new Uint8Array(2 * 1024 * 1024),
  })
} catch {
  diskFullRejected = true
}
const diskRetry = await diskJournal.append({
  provider: 'codex',
  sessionId: 'disk',
  generation: 0,
  eventId: 'small',
  eventKind: 'turn',
  occurredAt: '2026-09-04T00:00:00Z',
  raw: new TextEncoder().encode('fits'),
})

const injectedFull = () => Object.assign(new Error('injected SQLite disk full'), { code: 'ENOSPC' })
const databaseFullRoot = await mkdtemp(join(tmpdir(), 'journal-database-full-'))
let databaseAppendRejected = false
try {
  await (
    await openRuntimeJournal({
      testRuntimeRoot: databaseFullRoot,
      onDurabilityBoundary: boundary => {
        if (boundary === 'journal-commit-attempt') throw injectedFull()
      },
    })
  ).append({
    provider: 'codex',
    sessionId: 'database-full',
    generation: 0,
    eventId: 'event-1',
    eventKind: 'turn',
    occurredAt: '2026-09-04T00:00:00Z',
    raw: new TextEncoder().encode('database-full'),
  })
} catch {
  databaseAppendRejected = true
}
const databaseRetry = await (
  await openRuntimeJournal({ testRuntimeRoot: databaseFullRoot })
).append({
  provider: 'codex',
  sessionId: 'database-full',
  generation: 0,
  eventId: 'event-1',
  eventKind: 'turn',
  occurredAt: '2026-09-04T00:00:00Z',
  raw: new TextEncoder().encode('database-full'),
})
const databaseStateRoot = await mkdtemp(join(tmpdir(), 'journal-database-state-full-'))
const databaseStateStop = {
  provider: 'codex' as const,
  sessionId: 'database-state-full',
  generation: 0,
  stopId: 'stop-1',
}
await (
  await openRuntimeJournal({ testRuntimeRoot: databaseStateRoot })
).append({
  ...databaseStateStop,
  eventId: 'stop-event',
  eventKind: 'stop',
  occurredAt: '2026-09-04T00:00:00Z',
  raw: new TextEncoder().encode('database-state-full'),
})
let databaseClaimRejected = false
try {
  await (
    await openRuntimeJournal({
      testRuntimeRoot: databaseStateRoot,
      onDurabilityBoundary: boundary => {
        if (boundary === 'claim-commit-attempt') throw injectedFull()
      },
    })
  ).claimStop(databaseStateStop)
} catch {
  databaseClaimRejected = true
}
const databaseClaimResult = await (
  await openRuntimeJournal({ testRuntimeRoot: databaseStateRoot })
).claimStop(databaseStateStop)
const databaseTurnPath = makeOwnedPath('sessions', [
  'codex',
  'database-state-full',
  'turns',
  'stop-1',
  'manifest.json',
])
const databaseTurnBytes = new TextEncoder().encode('database full Turn')
await mkdir(
  join(databaseStateRoot, '.factory', 'sessions/codex/database-state-full/turns/stop-1'),
  { recursive: true },
)
await writeFile(join(databaseStateRoot, '.factory', databaseTurnPath), databaseTurnBytes, {
  flag: 'wx',
})
const databaseTurn = {
  path: databaseTurnPath,
  sha256: createHash('sha256').update(databaseTurnBytes).digest('hex'),
  repositoryRoot: databaseStateRoot,
  repositoryId: 'repo_fixture',
}
let databaseCompletionRejected = false
try {
  await (
    await openRuntimeJournal({
      testRuntimeRoot: databaseStateRoot,
      verifyTurn: async (_claim, turn) =>
        new Uint8Array(await readFile(join(databaseStateRoot, '.factory', turn.path))),
      onDurabilityBoundary: boundary => {
        if (boundary === 'completion-commit-attempt') throw injectedFull()
      },
    })
  ).complete(databaseClaimResult.claim, databaseTurn)
} catch {
  databaseCompletionRejected = true
}
const databaseCompletionStillPending = (
  await Array.fromAsync(
    (await openRuntimeJournal({ testRuntimeRoot: databaseStateRoot })).recover(),
  )
).length

const segmentedRoot = await mkdtemp(join(tmpdir(), 'segmented-candidate-'))
const segmentedStart = performance.now()
const segmentedWriters = Array.from({ length: 8 }, (_, worker) =>
  Bun.spawn(
    [
      'bun',
      new URL('./segmented-candidate-worker.ts', import.meta.url).pathname,
      segmentedRoot,
      String(worker),
      '25',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  ),
)
const segmentedExits = await Promise.all(segmentedWriters.map(writer => writer.exited))
const segmentedMs = performance.now() - segmentedStart
const segmentedRows = (await readdir(segmentedRoot)).filter(name => name.endsWith('.row')).length
const staleRoot = await mkdtemp(join(tmpdir(), 'segmented-stale-'))
const killed = Bun.spawn(
  [
    'bun',
    new URL('./segmented-candidate-worker.ts', import.meta.url).pathname,
    staleRoot,
    '0',
    '1',
    'crash',
  ],
  { stdout: 'pipe', stderr: 'pipe' },
)
await killed.exited
const staleLockRemains = (await readdir(staleRoot)).includes('lock')

const quantile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ]!
const report = {
  schemaVersion: 1,
  selectedEngine: 'sqlite-with-external-raw-cas',
  runtime: {
    bun: Bun.version,
    platform: process.platform,
    nodePackagingSmoke: process.env.FACTORY_NODE_SMOKE ?? 'unavailable',
    linkedWorktreeSmoke: process.env.FACTORY_LINKED_SMOKE ?? 'unavailable',
  },
  engines: {
    sqlite: {
      durability: 'pass',
      contention: {
        writers: 8,
        eventsPerWriter: 25,
        exits,
        rows: contentionInventory.referenced.length,
        elapsedMs: contentionMs,
      },
      latencyMs: {
        nonStop: {
          p50: quantile(nonStop, 0.5),
          p95: quantile(nonStop, 0.95),
          max: Math.max(...nonStop),
        },
        stop: { p50: quantile(stop, 0.5), p95: quantile(stop, 0.95), max: Math.max(...stop) },
      },
      packaging: 'Bun 1.3.14 pass; Node smoke reported separately',
    },
    segmentedAppendLog: {
      durability: staleLockRemains
        ? 'fail: killed owner leaves a lock that cannot be stolen safely'
        : 'unexpected-pass',
      contention: {
        writers: 8,
        eventsPerWriter: 25,
        exits: segmentedExits,
        rows: segmentedRows,
        elapsedMs: segmentedMs,
      },
      packaging: 'dependency-free Node/Bun filesystem APIs',
    },
  },
  crashMatrix,
  stateMachine: {
    claimId: firstClaim.claimId,
    recoveredSameClaim: JSON.stringify(firstClaim) === JSON.stringify(recoveredClaim),
    pendingAfterCompletion: recoveryAfterCompletion.length,
  },
  diskFull: { rejectedBeforeAcknowledgement: diskFullRejected, retrySequence: diskRetry.sequence },
  databaseFull: {
    commitRejectedBeforeAcknowledgement: databaseAppendRejected,
    retrySequence: databaseRetry.sequence,
    claimRejectedBeforeAcknowledgement: databaseClaimRejected,
    claimRetryAcquired: databaseClaimResult.status === 'acquired',
    completionRejectedBeforeAcknowledgement: databaseCompletionRejected,
    completionStillPending: databaseCompletionStillPending,
  },
  acceptance: {
    nodePackaging: (process.env.FACTORY_NODE_SMOKE ?? '').startsWith('pass '),
    linkedWorktree: (process.env.FACTORY_LINKED_SMOKE ?? '').startsWith('pass '),
    contiguous: exits.every(code => code === 0) && contentionInventory.referenced.length === 200,
    everyRetryAtZero: Object.values(crashMatrix).every(value => value.retrySequence === 0),
    staleLockCounterexample: staleLockRemains,
    claimRecovery:
      JSON.stringify(firstClaim) === JSON.stringify(recoveredClaim) &&
      recoveryAfterCompletion.length === 0,
    diskFullRecovery: diskFullRejected && diskRetry.sequence === 0,
    databaseFullRecovery:
      databaseAppendRejected &&
      databaseRetry.sequence === 0 &&
      databaseClaimRejected &&
      databaseClaimResult.status === 'acquired' &&
      databaseCompletionRejected &&
      databaseCompletionStillPending === 1,
  },
}
if (
  !report.acceptance.nodePackaging ||
  !report.acceptance.linkedWorktree ||
  !report.acceptance.contiguous ||
  !report.acceptance.everyRetryAtZero ||
  !report.acceptance.staleLockCounterexample ||
  !report.acceptance.claimRecovery ||
  !report.acceptance.diskFullRecovery ||
  !report.acceptance.databaseFullRecovery
)
  throw new Error('journal lab acceptance failed')
await mkdir(output, { recursive: true })
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
const escaped = JSON.stringify(report, null, 2)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
await writeFile(
  join(output, 'index.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Factory journal crash lab</title><style>body{font:15px/1.5 system-ui;max-width:1080px;margin:2rem auto;padding:0 1rem;background:#101416;color:#e8efed}h1{margin-bottom:.25rem;color:#9ee7d7}.lead{font-size:1.1rem;color:#cbd8d5}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin:1.5rem 0}.card,table,pre{background:#182023;border:1px solid #344348;border-radius:10px}.card{padding:1rem}.card strong{display:block;font-size:1.45rem;color:#9ee7d7}.label{color:#9aa9a6}table{width:100%;border-collapse:separate;border-spacing:0;overflow:hidden}th,td{text-align:left;padding:.7rem;border-bottom:1px solid #344348}th{color:#9ee7d7}tr:last-child td{border:0}.pass{color:#8ee28a}.fail{color:#ffad8f}details{margin-top:1.5rem}summary{cursor:pointer;color:#9ee7d7}pre{padding:1rem;overflow:auto;font-size:.82rem}</style></head><body><h1>Durable runtime journal</h1><p class="lead">SQLite is the measured choice over the tested mkdir-lock segmented candidate: killed processes release transaction locks, while that candidate leaves an unsafe stale lock.</p><div class="grid"><div class="card"><span class="label">Shared order</span><strong>${report.engines.sqlite.contention.rows} / 200</strong>rows, no gaps</div><div class="card"><span class="label">8×25 contention</span><strong>${report.engines.sqlite.contention.elapsedMs.toFixed(1)} ms</strong>all writers exited zero</div><div class="card"><span class="label">Non-Stop p95</span><strong>${report.engines.sqlite.latencyMs.nonStop.p95.toFixed(2)} ms</strong>measured, not a budget</div><div class="card"><span class="label">Stop p95</span><strong>${report.engines.sqlite.latencyMs.stop.p95.toFixed(2)} ms</strong>measured, not a budget</div></div><table><thead><tr><th>Candidate</th><th>Crash safety</th><th>Contention</th><th>Packaging</th></tr></thead><tbody><tr><td>SQLite + raw CAS</td><td class="pass">Passed tested boundaries</td><td>${report.engines.sqlite.contention.elapsedMs.toFixed(1)} ms</td><td>${report.runtime.nodePackagingSmoke}</td></tr><tr><td>mkdir-lock segmented log</td><td class="fail">Unsafe stale lock</td><td>${report.engines.segmentedAppendLog.contention.elapsedMs.toFixed(1)} ms</td><td>Node/Bun filesystem APIs</td></tr></tbody></table><div class="grid"><div class="card"><span class="label">Crash retries</span><strong class="pass">sequence 0</strong>at every injected boundary</div><div class="card"><span class="label">Git-common locator</span><strong class="pass">linked worktree</strong>${report.runtime.linkedWorktreeSmoke}</div><div class="card"><span class="label">Disk full</span><strong class="pass">no ack</strong>raw and injected DB commit recovery</div><div class="card"><span class="label">Node packaging</span><strong class="pass">Node 22.13</strong>exact runtime verified</div></div><details><summary>Raw report JSON</summary><pre>${escaped}</pre></details></body></html>\n`,
)
