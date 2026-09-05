# 05 — Safe Git and code observation

Status: **implemented**

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
  loadCodeManifest(ref: ObjectRef): Promise<CodeManifest>;
  reconstruct(manifest: CodeManifest, destination: EmptyDirectory): Promise<void>;
}
```

`CodeManifest` is a public, runtime-validated CAS payload owned by
`@factory/contract`. `GitObjectStore` supplies byte storage without coupling
observation to `.factory` publication; observation completes its ending
sentinel before writing any file, manifest, or patch object through that seam.

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
- Assert refs, branch, index, config, and worktree bytes and modes are
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

## Implemented evidence

`bun run lab:git-observation` runs in a network-disabled, read-only Docker
environment with Git and the repository-pinned Bun 1.3.14. It emits a
sanitized ordinary reconstruction and a deliberately raced capture under
`assets/git-observation-workbench/`. The Docker suite covers raw non-UTF-8
paths, ordinary/executable modes, safe/escaping/cyclic symbolic links, unborn
and detached HEAD, linked and relocated worktrees, ignored and sparse paths,
submodule and LFS pointers, measured size exclusion, and hostile filters,
external diff drivers, hooks, fsmonitor configuration, and an intermediate
symlink aimed at bytes outside the checkout. An unreadable path stays an
explicit partial limitation and never suppresses other readable evidence.
The reconstruction fixture swaps its destination for an outside symlink after
the destination descriptor is bound and proves all writes remain confined and
the failed replacement remains untouched. It also injects an unmanifested
symlink after the bind and corrupts a later object, proving exact-tree rejection,
preservation of foreign replacements, rejection of special files, changed bytes,
special permission bits, and oversized final entries without unbounded reads.
Failed destinations are explicitly disposable and retain partial entries rather
than risk a pathname cleanup race that could delete a foreign replacement.
Every fixture runs without network access.

The observer never asks Git to compare live worktree files: even status-shaped
commands may run a configured clean filter for a same-size change. It derives
changed paths from byte-read worktree content, index object identities, and the
HEAD tree instead. Exact bytes and identities retain the state required for a
later derivation without executing repository code. Git stdout and stderr are
bounded and every command has a deadline. The 64 MiB per-file bound,
256 MiB observation bound, and 64 KiB read chunk are initial measured limits;
large-repository latency and native macOS behavior remain Slice 12 release
authorities rather than claimed passes here. The descriptor backend is loaded
only when reconstruction is requested: this slice verifies Bun on glibc Linux;
macOS, musl Linux, and Node import/runtime behavior remain explicit Slice 12
release gates rather than claimed support. Native `readdir` distinguishes EOF
from a nonzero `errno`, but deterministic fault injection for that libc branch
also remains a Slice 12 platform-gate obligation; the v1 harness covers its
ordinary EOF path without adding a second injectable native backend.
