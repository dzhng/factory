# 05 — Safe Git and code observation

## Contract

Observe HEAD, index, worktree, and untracked code without executing repository
filters or hooks and without changing refs, index, config, branch, or bytes.
Record start/end fingerprints and typed races. Reconstruct supported snapshots
into a fresh directory with no `.git`, preserving paths as bytes and inventorying
every limitation.

## API seam

```ts
type ObservationResult =
  | { kind: "observed"; observation: RepositoryObservation }
  | { kind: "raced"; partial: RepositoryObservation; race: RaceFact }
  | { kind: "unavailable"; reason: ObservationUnavailable };

interface GitObserver {
  observe(): Promise<ObservationResult>;
  reconstruct(manifest: CodeManifest, destination: EmptyDirectory): Promise<void>;
}
```

All subprocess calls are typed argument arrays from a read-only Git operation
allowlist. No shell strings cross this boundary.

## Runnable artifact

`bun run lab:git-observation` builds hostile fixture repositories, prints a
sanitized observation, reconstructs each snapshot, and emits a before/after Git
sentinel comparison.

## Verification

- Cover no remote, unborn/detached HEAD, linked worktrees, moved checkout,
  binary/non-UTF-8 paths, executable modes, safe/unsafe/cyclic links, sparse and
  ignored/untracked files, submodules, LFS pointers, and mutation during capture.
- Disable filters, text conversion, pagers, hooks, fsmonitor side effects, and
  network/lazy fetch.
- Stream large objects with measured limits and typed limitations.
- Assert refs, branch, index, config, worktree bytes, and `git status` are
  identical before and after every probe.

## Delegated decisions

Streaming chunk size and initial measured size limits. Inclusion semantics,
race truthfulness, path encoding, and Git non-mutation are not delegated.

## Must stay green

The live checkout never becomes a reviewer input mount. Unsupported submodule
or LFS content stays a visible pointer/limitation, never an implicit fetch.

## Human checkpoint and feedback

Inspect one ordinary and one raced reconstruction report. If large-repository
latency or a platform Git behavior breaks the contract, reslice that case and
retain typed partiality; do not invoke mutating Git commands to compensate.
