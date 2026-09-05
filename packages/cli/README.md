# CLI

The CLI composes Factory's domain owners. It discovers repository and provider
locations, applies hook patch plans, routes a native Session to its first
initialized repository, and invokes capture recovery. It never constructs
repository-owned paths or writes `.factory` directly.

Configuration display and execution share the same precedence fold: repository
preferences override global preferences, which override built-in defaults. The
CLI's configuration reader owns validation of the private global file.

`factory capture` is deliberately fail-open for Codex and Claude Code: after
input classification it always emits the provider's valid empty response and
exits successfully, even when durable capture or materialization fails. Raw
evidence that reached the journal remains recoverable.

Automatic review is opt-in. Capture wakes a detached review process after
durable Stop materialization; SessionStart can recover a missed wake-up. The
existing subject lock and durable triggers govern execution. A non-waiting
per-worktree worker lock coalesces overlapping wakes instead of accumulating
waiting processes. Workers recheck durable triggers after releasing ownership
so a wake arriving during shutdown is not lost; hooks never wait for the reviewer.
A failed attempt remains visible and manually retryable; new evidence can
trigger another attempt, but an unchanged failure does not create a retry loop.
A private fixed-size fingerprint suppresses unchanged pending sets even when
planning cannot publish a manifest. It is scheduling state, never review
coverage, and manual review does not consult it.

Global hook ownership is private operational state. Exact recorded
fingerprints authorize removal; foreign, duplicate-looking, and user-edited
entries remain untouched. Installation code owns bounded, no-follow reads of
provider configuration, transaction recovery, and a typed inspection that
compares actual hooks with provider-owned semantics. `factory doctor` is
read-only unless `--repair` is explicit and reports that inspection without
including provider configuration bytes.

All install mutations journal through one tagged installation transaction.
Hook reconciliation is its first operation kind; executable upgrade extends
that same recovery owner rather than creating a parallel update journal. The
upgrade boundary accepts only an artifact-verifier capability, stages on the
installed executable's filesystem, proves the staged binary's embedded version
before replacement, and serializes install, uninstall, repair, and upgrade with
one operating-system-released lock. Recovery promotes only a stage whose journal
records completed verification; interrupted or failed verification retains the
old executable.

Diagnostic policy is a pure fold over typed observations supplied by the
repository, runtime journal, GitHub, installation, and reviewer owners. A
canonical-branch disagreement is high priority only when GitHub actually
reported its default; offline branch-name fallbacks never manufacture drift.

`factory open` rebuilds a presentation projection from portable repository
records, serves it only on `127.0.0.1`, and stops when the command exits. The
browser receives two narrow append-only action seams—decision actions and
explicit partial-coverage acceptance—not a generic repository writer.
Display refreshes reuse the GitHub diagnostic policy with a short discovery
deadline. Action validation reads local evidence without waiting for GitHub.
