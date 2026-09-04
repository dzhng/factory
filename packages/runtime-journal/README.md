# Runtime journal

This package is the only authority for capture bytes before they become a
verified immutable Turn in `.factory`. It keeps one journal under the Git common
directory, so linked worktrees share ordering while each row may retain the
operational worktree path needed by materialization.

The journal deliberately separates two durability mechanisms. Exact provider
bytes enter a synced content-addressed object before a SQLite transaction may
reference them; SQLite owns ordering, idempotency, and the Stop state machine.
Its transaction locks are released by the operating system after process death,
which is the property a user-space stale-lock protocol could not safely provide.

A Stop claim is a permanent fence, not a lease. It freezes one Session
generation's event identities through the claimed Stop, survives restart, and
is completed only with a repository-store-verified immutable Turn reference.
No process ID, timestamp, or apparent owner death can replace it.

`claimStop` grants execution only to the transaction that creates the claim.
Other concurrent callers receive `already-claimed`; after a crash, recovery is
the explicit path for resuming the same frozen claim. `readClaimEvents` returns
the verified metadata and exact raw bytes needed to materialize it. Completion
requires a repository-owned verification capability, so a syntactic path or
hash cannot suppress recovery.

Production callers pass a repository worktree, never an arbitrary runtime
path. The journal resolves `.git/commondir` and creates one private (`0700`)
runtime beneath the Git common directory. The explicit runtime-root seam exists
only for isolated tests and crash labs. Runtime files are private (`0600`), and
owned paths reject symbolic links.

The runtime database and its indexes are recoverable machine state, never
portable history. Once the repository store verifies the corresponding Turn,
runtime objects may be reclaimed without changing `.factory`.

Callers close a journal handle when its hook invocation or materialization pass
ends. The package requires Node 22.13 or newer because earlier Node 22 releases
do not provide the SQLite runtime it uses; Bun uses its built-in SQLite binding.

Recovery is deliberately bounded: a journal lifetime admits 100,000 rows and
64 MiB of event metadata, while one Turn admits 10,000 events and 64 MiB of raw
bytes. Claims are capped at 1 MiB, completions at 128 KiB, and each state table
at 64 MiB. Database metadata is preflighted and read in bounded pages; raw files
are size-checked before allocation and read incrementally. If one unclaimed Turn
exceeds its recovery bound, `recover` returns a typed `unavailable` item for that
Stop and continues yielding other ready Stops. These bounds make corruption or
runaway provider input visible without letting one bad range starve unrelated
materialization.

Post-Stop SessionEnd events have their own completion record so a crash cannot
strand lifecycle evidence after a Turn is already complete. SessionStart remains
inside the first Stop claim and never creates a portable Session on its own.
