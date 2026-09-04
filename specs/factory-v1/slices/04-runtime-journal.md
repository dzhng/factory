# 04 — Durable runtime journal

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
  claimStop(stop: StopIdentity): Promise<MaterializationClaim>;
  complete(claim: MaterializationClaim, turn: TurnRef): Promise<void>;
  recover(): AsyncIterable<RecoveryWork>;
}
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

## Must stay green

The runtime root is outside `.factory`; credentials never enter it; hooks never
launch reviews; no runtime database becomes canonical after materialization.

## Human checkpoint and feedback

Review the crash/latency matrix and approve the measured engine choice. If one
root cannot safely model Git-common and per-worktree state, split common journal
identity from worktree operational state rather than weakening ordering.
