# 04 — Durable runtime journal

Status: **implemented**

## Contract

A hook acknowledges only after its exact raw bytes and journal row are durable
under the Git common directory's `factory-runtime`. Concurrent hook processes
allocate an unbroken logical order, retries are idempotent, and crashes reopen
without phantom or duplicate records. Hook failure remains provider-valid and
non-blocking while leaving a private diagnostic when possible.

## API seam

```ts
interface RuntimeJournal {
  append(input: RawCaptureInput): Promise<DurableCaptureReceipt>;
  appendNonBlocking(input: RawCaptureInput): Promise<HookCaptureResult>;
  claimStop(stop: StopIdentity): Promise<ClaimStopResult>;
  readClaimEvents(claim: MaterializationClaim): Promise<ClaimEvent[]>;
  complete(claim: MaterializationClaim, turn: TurnRef): Promise<void>;
  recover(): AsyncIterable<RecoveryWork>;
  close(): Promise<void>;
}

type RecoveryWork =
  | { availability: "ready"; stop: StopIdentity; claim?: MaterializationClaim; events: DurableCaptureEvent[] }
  | { availability: "unavailable"; stop: StopIdentity; claim?: MaterializationClaim; events: []; limitation: RecoveryLimitation };
```

The journal is the only runtime authority before verified materialization. Its
rows may point only to already-durable runtime objects. Runtime paths never enter
portable metadata.

## Runnable artifact

`bun run lab:journal-crash` replays a fixed event stream while killing writers
at every durability boundary, then emits the recovered order, claims, latency,
and orphan inventory.

## Verification

- Port the donor's 8-by-25 concurrent sequencing oracle.
- Inject failure around object sync, journal commit, claim, completion, process
  kill, reopen, disk-full, corruption, and linked-worktree contention.
- Demonstrate CAS-before-reference and exclusive/idempotent Stop claims.
- Measure non-Stop and Stop latency rather than inventing budgets.
- Delete derived indexes and prove all portable projections remain rebuildable.

## Delegated decisions

SQLite versus a segmented append log is delegated only after the lab compares
durability, Node 22 packaging, contention, and measured latency. Table/index
layout and backoff are implementation details.

## Implementation evidence

The [crash report](../assets/journal-crash/index.html) selects SQLite with an
external raw-byte CAS. A synced raw object is atomically published before its
row transaction can commit. One transactional counter advances only for a new
idempotency identity, so retries cannot consume sequence numbers. Stop claims
freeze their exact cutoff and event identities and are permanent fences rather
than time- or process-based leases.

The Docker verification suite and lab kill writers after every raw publication
and transaction boundary, reopen and retry them, repeat the 8-by-25 shared-root
contention oracle, exhaust a real tmpfs, inject SQLite `ENOSPC` before event,
claim, and completion commits, corrupt durable data, delete a derived
projection, and exercise claim recovery and completion. A linked-worktree
metadata fixture separately proves both worktrees resolve the same Git-common
journal. The generated JSON contains measured non-Stop and Stop latency rather
than a budget invented in advance.

Recovery preflights aggregate metadata and reads SQLite rows in bounded pages.
An over-limit Turn is reported as typed unavailable work without preventing
other Session Stops from being recovered. Claim and completion JSON have
individual and table-wide bounds before parsing or durable acknowledgement.

The same built package completed a host Node 24 SQLite smoke test. Because
`node:sqlite` is not available throughout the original Node 22 line, this
package declares Node 22.13 or newer. The complete Docker suite passes in the
pinned Bun 1.3.14 image. Exact Node 22.13 packaging authority remains a release
evidence gap rather than an inferred pass.

The human checkpoint resolves provisionally in favor of SQLite over the tested
mkdir-lock segmented candidate: both completed the concurrency workload, while
killing that candidate left a stale owner lock that cannot be stolen without
racing a new owner. This does not disprove every segmented or `fcntl`-fenced
design; replacing SQLite requires measuring such a concrete recoverable design,
not adding a faster timeout or PID heuristic to the failed candidate.

## Must stay green

The runtime root is outside `.factory`; credentials never enter it; hooks never
launch reviews; no runtime database becomes canonical after materialization.

## Human checkpoint and feedback

Review the crash/latency matrix and approve the measured engine choice. If one
root cannot safely model Git-common and per-worktree state, split common journal
identity from worktree operational state rather than weakening ordering.
