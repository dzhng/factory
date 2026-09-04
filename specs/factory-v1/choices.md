# Factory v1 decision ledger

This ledger records why the specification has its current shape. It is not a
second normative schema; the master specification and format own mechanics.

## Product

- Use the name Factory, command `factory`, and repository directory `.factory`.
- Build a local OSS CLI first. Future SaaS ingests the local format rather than
  redefining it.
- Keep the old hosted repository unchanged as a selective donor.
- Use a localhost UI, not a daemon or hosted web product.
- Treat v1 as greenfield. Do not build legacy readers, donor importers,
  compatibility shims, dual writes, or repository-data migrations. A minimum
  reader gate protects data by refusing unsafe reads; it is not a migration
  mechanism.

## Model

- One native provider session is one Session.
- Remove mandatory Epics. Their time/path/worktree heuristics were too brittle
  to represent intent and created a parallel hierarchy beside Git.
- Preserve direct many-to-many Session/PR evidence.
- Treat workspace and PR as review subjects.
- Treat branches as observed navigation context, not immutable identities.
- Use the configured canonical branch to distinguish canonical decisions from
  feature proposals.

## Capture and storage

- Commit complete plaintext evidence on the same branch as code.
- Journal every hook event durably, then materialize immutable chunks at Stop.
- Use per-Stop files to avoid append conflicts.
- Use ordinary Git and content-addressed deduplication; no LFS or pruning.
- Preserve unknown `.factory` contents and never mutate Git state.
- Permit absolute paths inside lossless provider evidence while excluding them
  from Factory-generated portable metadata.

## Review

- Explicit review is the default; automatic review is configurable.
- Advisory exit is the default; `--fail-on` is opt-in enforcement.
- Coalesce pending Stops and review incrementally by evidence watermark.
- Review readable partial bundles rather than missing the review entirely.
- Leave partial triggers unsettled until recovery or explicit acceptance.
- Select PR Sessions only from exact or verified evidence.
- Select workspace evidence inclusively but label weak candidates.
- Use the newest Stop to select the cross-harness reviewer.
- Force-pushes and base changes trigger full current-code review.

## Configuration and installation

- Default to explicit repository initialization.
- Allow global opt-in automatic initialization.
- Let repository config override global schema-defined settings.
- Do not add a Factory trust registry.
- Discover canonical branch with `gh` when available, then commit the confirmed
  value so remote changes cannot silently redefine it.
- Ship global CLI-installed hooks only in v1; plugin detection and distribution
  are deferred entirely.
- Keep the public command surface to `configure`, `init`, `install`,
  `uninstall`, `doctor`, `capture`, `review`, `open`, and `upgrade`. Planning
  probes used during implementation belong to the test harness, not to a
  speculative public `status` or `inspect` namespace.

## Security

- Reuse provider-owned authentication and mount it read-only.
- Give reviewers immutable bundles and one writable output directory.
- Never mount the live checkout or Docker socket.
- Keep Docker network access for the selected model provider.
- Record sanitized immutable failed attempts while keeping transient logs in
  runtime state.

## Implementation choices — workspace bootstrap

### Pin the initial toolchain exactly

- **When:** Workspace bootstrap before Slices 01 and 02.
- **The choice:** Factory pins Bun 1.3.14, Turborepo 2.10.3, TypeScript 5.9.2,
  oxfmt 0.57.0, and oxlint 1.72.0. A fresh clone therefore installs the same
  tools that produced the checked-in lockfile instead of silently receiving a
  newer compiler or formatter with different output.
- **The gap:** The spec fixed Node 22, Bun, and Turborepo but did not fix every
  development-tool version.
- **The reach:** Every workspace inherits these parser, type-checking, task, and
  formatting semantics until an explicit dependency update changes them.
- **Verdict:** Sound. Exact tools make the replication labs reproducible and
  match the proven donor/conventions baseline.
- **Confidence:** High.

### Keep shared TypeScript policy at the repository root

- **When:** Workspace bootstrap before Slices 01 and 02.
- **The choice:** Packages extend one root `tsconfig.json`. The alternative was
  a `typescript-config` workspace whose only job would be to re-export compiler
  settings. Browser or other genuinely different environments may add a narrow
  child config when they arrive.
- **The gap:** The spec required strict shared TypeScript configuration but did
  not choose whether that configuration was a package.
- **The reach:** New packages have one default type policy without adding a
  dependency or a package that owns no runtime/project semantics.
- **Verdict:** Sound. It preserves one owner and avoids an empty abstraction.
- **Confidence:** Medium.

### Do not auto-format prose with the source-code gate

- **When:** Workspace bootstrap before Slices 01 and 02.
- **The choice:** The root formatter checks source and structured configuration,
  while Markdown remains a reviewed documentation surface. The alternative was
  to reflow specs and project skills whenever source formatting ran, creating
  unrelated documentation churn in implementation commits.
- **The gap:** The spec required formatting gates but did not define whether
  prose belonged to the automatic source formatter.
- **The reach:** Source passes stay focused; documentation correctness is checked
  by the write-docs/link review rather than formatter output.
- **Verdict:** Sound. It keeps commits attributable without weakening source
  formatting.
- **Confidence:** Medium.

## Implementation choices — reviewer isolation oracle

### Kill the container, not only the waiting client

- **When:** Slice 02 reviewer-isolation implementation.
- **The choice:** A reviewer starts detached, while Factory waits through a
  separate Docker client process. If a review times out or is cancelled,
  Factory stops waiting and forcibly removes the named container. Docker then
  kills the whole container process namespace, including a child process the
  reviewer started. Merely killing the local `docker wait` command would leave
  that container and its descendants running in the background.
- **The gap:** The spec required timeout, cancellation, descendant cleanup, and
  container removal but did not choose the process-control sequence.
- **The reach:** The production reviewer executor inherits a cleanup path that
  addresses the actual isolation unit. A future engine may replace Docker, but
  it must retain this whole-sandbox cancellation property.
- **Verdict:** Sound. Cleanup is tied to the resource that owns every reviewer
  process rather than to one observer of that resource.
- **Confidence:** High.

### Give the container a small disposable filesystem, not a writable root

- **When:** Slice 02 reviewer-isolation implementation.
- **The choice:** The reviewer runs as an explicitly observed unprivileged
  numeric user, with all Linux capabilities dropped, a read-only root
  filesystem, and a 16 MiB temporary filesystem at `/tmp`. Public test
  credentials use user `65532`; a private provider-owned credential uses its
  validated non-root owner UID and a fixed unprivileged group so the file can
  stay mode `0600`. For
  example, a CLI may create a Unix socket or scratch file in `/tmp`, but it
  cannot install files into its image or modify mounted evidence. The
  alternative was a writable root filesystem whose mutations would disappear
  later but could hide undeclared reviewer dependencies.
- **The gap:** The plan delegated the base image and disposable cache layout; it
  did not set the container user or initial scratch-space budget.
- **The reach:** Slice 09 can depend on immutable image state and one bounded
  scratch location. The 16 MiB value is an oracle starting point, not a public
  format promise; authenticated provider runs must measure it before release.
- **Verdict:** Sound. It proves the stronger isolation shape while leaving one
  reversible size knob for measured provider needs.
- **Confidence:** Medium.

### Make the build gate produce distributable package output

- **When:** Slice 02 integration on `main`.
- **The choice:** The production package build emits JavaScript and declarations
  under `dist`, while the executable test harness emits a bundled lab. In both,
  `check-types` remains the no-output compiler check. The alternative was to
  call `tsc --noEmit` from both commands, which let type checking pass but left
  Turbo's promised build output empty.
- **The gap:** The workspace bootstrap named separate build and type gates but
  did not state whether library packages should emit artifacts this early.
- **The reach:** Every package added later should keep build output and type-only
  validation as distinct contracts, so release tests can exercise what is
  actually shipped.
- **Verdict:** Sound. A green build now proves an artifact exists instead of
  renaming another check.
- **Confidence:** High.

### Authorize mounts by canonical filesystem identity

- **When:** Slice 02 integration security review.
- **The choice:** Resolve every bind-mount source to its real host path, rerun
  overlap policy on those canonical identities, pass only the canonical paths
  to Docker, and refuse commas that Docker's mount-option grammar can
  reinterpret. Factory creates the stopped container, verifies Docker's
  observed sources, targets, modes, and policy, and only then starts it. The
  alternative was to trust lexically distinct input strings and requested
  arguments, which allowed either a symlink or option injection to change what
  the reviewer could access before a post-start check noticed.
- **The gap:** The planned pure mount API described path overlap but did not say
  whether identity meant spelling or the filesystem object Docker would mount.
- **The reach:** Every future reviewer adapter inherits the same pre-execution
  boundary. Symlinks cannot widen writable authority or disguise auth/bundle
  aliasing, and Docker inspection detects disagreement with the verified plan.
- **Verdict:** Sound. Security follows the resources Docker receives rather than
  user-controlled path notation.
- **Confidence:** High.

### Certify real providers only through the production execution path

- **When:** Slice 02 integration authority review.
- **The choice:** Slice 02 proves the provider-independent isolation boundary
  with an instrumented fake image and records unavailable authorities exactly.
  Authenticated Codex and Claude certification moves to Slice 09, where the
  packaged images and real invocation adapters exist. The alternative was a
  second oracle-only provider launcher that would either be throwaway code or a
  parallel security boundary.
- **The gap:** The original Slice 02 text required real provider execution
  before the production images and invocation seam were scheduled to exist.
- **The reach:** Slice 09 is a release blocker until both current providers run
  with dedicated test credentials on required platforms; unavailable remains a
  typed result and never counts as a pass.
- **Verdict:** Sound. It retains the acceptance authority while ensuring the
  certified path is the one Factory actually ships.
- **Confidence:** High.

## Implementation choices — Slice 01 provider oracle

### Keep generated oracle evidence with the specification

- **When:** Slice 01, provider/reference oracle.
- **The choice:** Running the provider lab writes a human-readable HTML report
  and matching JSON under the Factory v1 spec's assets. For example, a reviewer
  can open the report, follow a fixture link, and compare the claim with the
  exact bytes. The alternative was a generic root output directory whose files
  would have no durable owner and could be mistaken for disposable build output.
- **The gap:** The slice required a browser-playable HTML/JSON artifact but did
  not choose its repository home.
- **The reach:** Future feasibility evidence belongs to the spec it justifies;
  production runtime output must not copy this convention into `.factory`.
- **Verdict:** Sound. The artifact is deliberate review evidence and the spec is
  its natural owner.
- **Confidence:** High.

### Use SQLite only as the concurrency experiment's measuring instrument

- **When:** Slice 01, provider/reference oracle.
- **The choice:** Eight disposable container processes each allocate twenty-five
  rows in one lab-only SQLite table, then the lab verifies the resulting sequence
  is exactly 0 through 199 with no duplicates. This proves that the donor's
  cross-process sequencing test has been reproduced. It does not select SQLite
  for Factory's runtime journal; the alternative was silently allowing the
  feasibility lab to become the production storage decision before the journal
  crash tests exist.
- **The gap:** The slice required concurrent sequencing evidence but deliberately
  left the production journal engine to a later measured decision.
- **The reach:** Slice 04 must rerun the same observable property against its real
  journal seam. No production package imports this lab implementation.
- **Verdict:** Sound. The experiment measures the invariant without pre-deciding
  the production owner.
- **Confidence:** High.

### Treat missing certification as data instead of borrowing a login

- **When:** Slice 01, provider/reference oracle.
- **The choice:** The report distinguishes installed-client versions observed by
  the authority audit from a credential-free Docker certification and from an
  authenticated hook run. Docker could not resolve its image registry, and no
  dedicated test credential was present, so the latter two facts are recorded as
  unavailable. The alternative was to read the developer's working provider
  login or label a host observation as a container pass.
- **The gap:** The plan defined the security boundary and unavailable evidence,
  but the executing environment supplied neither registry access nor test auth.
- **The reach:** Later slices may rely on donor-derived raw-byte behavior, but
  they cannot claim a current live event inventory until the guarded refresh
  succeeds. Reversal is simply rerunning the checked-in probes in a suitable
  environment; successful evidence replaces the unavailable observation in a
  new commit.
- **Verdict:** Sound. It preserves the credential boundary and prevents an
  unavailable check from becoming false confidence.
- **Confidence:** High.

### Keep callback output a donor fixture claim, not a production protocol

- **When:** Slice 01, provider/reference oracle.
- **The choice:** The process lab reproduces the donor's fail-open callback shape:
  both a stored event and an internal capture failure exit zero and emit an empty
  JSON object. Because current authenticated hooks were not run, the report calls
  this fixture behavior rather than asserting that every current provider event
  requires this output. The alternative was to promote one donor wrapper's bytes
  into Factory's hook protocol without current-client evidence.
- **The gap:** The slice asks for provider-valid success and failure output, while
  this environment cannot execute authenticated current hooks.
- **The reach:** The capture vertical must certify its final provider-specific
  output through guarded live tests; until then, only the non-blocking and valid
  JSON properties are inherited.
- **Verdict:** Sound. The evidence remains useful without claiming more authority
  than it has.
- **Confidence:** Medium.

## Implementation choices — Slice 03 repository format

### Keep executable schemas dependency-free and colocated with public types

- **When:** Slice 03 public-format implementation.
- **The choice:** `@factory/contract` owns TypeScript record types, exact
  top-level runtime validators, enums, canonical encoding, ID/path helpers, and
  owned-path construction in one module. The alternative was introducing a
  schema library or generating a second schema representation before any
  consumer exists, creating two authorities or a dependency-driven public
  format.
- **The gap:** The spec delegated the schema-validation library but required one
  schema and owned-path authority.
- **The reach:** Later slices import this package directly. Public field changes
  must update the type and validator together, while configuration remains the
  deliberate unknown-field-preserving exception.
- **Verdict:** Sound for v1. The contract is small enough to review directly and
  does not inherit third-party coercion or unknown-field defaults.
- **Confidence:** Medium.

### Use create-only hard links as the immutable publication point

- **When:** Slice 03 repository writer implementation.
- **The choice:** Immutable bytes are written to a unique temporary file in the
  Git common directory's `factory-runtime` staging area and published with an
  atomic hard link. A concurrent identical writer converges after byte
  comparison; different bytes fail. Mutable config is staged there and uses an
  atomic rename. The alternative was direct exclusive writes, which can expose
  truncated records after interruption, or temporary files under `.factory`,
  which can leak runtime debris into committed evidence after a crash.
- **The gap:** The spec required atomic create-only behavior but delegated
  temporary naming and publication mechanics.
- **The reach:** Every future Session, observation, trigger, review, and decision
  record gets the same no-overwrite boundary without file-type-specific writers.
- **Verdict:** Sound on the supported local filesystems and directly exercised
  under concurrent Docker workbench writes.
- **Confidence:** High.

### Bound individual CAS objects at 64 MiB by default

- **When:** Slice 03 object-store implementation.
- **The choice:** The store refuses an individual object above 64 MiB unless its
  caller supplies a narrower or wider explicit repository-store limit. The
  alternative was unbounded accumulation by a malformed provider input before
  later review bundle limits could apply.
- **The gap:** The spec required oversized-object refusal but did not supply the
  initial object boundary.
- **The reach:** Capture adapters must segment larger evidence or make a reviewed
  limit decision. The value is an implementation safety default, not an excuse
  to truncate canonical provider bytes silently.
- **Verdict:** Sound but should be revisited with real large-transcript evidence
  during Slice 06.
- **Confidence:** Medium.

### Refuse cross-filesystem Git metadata in v1

- **When:** Slice 03 atomic-publication review.
- **The choice:** V1 requires the worktree and Git common directory to share a
  filesystem. Factory uses a read-only device preflight and converts `EXDEV`
  from the actual hard-link or rename publication into a typed refusal. The
  latter is authoritative where mount topology is stricter than device
  identity. The alternative was to stage inside `.factory`, leaving crash
  debris in committed data, or silently fall back from create-only atomic
  publication.
- **The gap:** The runtime companion was assigned to the Git common directory,
  but the original format did not state the filesystem identity needed by its
  publication primitive.
- **The reach:** Ordinary repositories and same-filesystem worktrees work as
  specified. Supporting split filesystems later requires a newly proven
  publication mechanism and an explicit format/runtime contract change.
- **Verdict:** Sound for an unlaunched v1: a typed limitation is safer than
  weakening immutability or contaminating `.factory`.
- **Confidence:** High.

### Serialize repository mutations behind one runtime lock

- **When:** Slice 03 concurrency and compatibility review.
- **The choice:** Every object publication, immutable record creation, and
  config update acquires one repository-runtime lock and rereads the current
  root manifest before touching `.factory`. Config merging happens inside that
  lock. The alternative was independent atomic file operations: individually
  untorn, but able to lose concurrent config fields or write through a store
  handle opened before Git moved to a newer format manifest.
- **The gap:** The spec required concurrent immutable convergence and a
  read-before-mutation compatibility stop, but did not define their shared
  operation boundary.
- **The reach:** All later writers inherit one correctness boundary. Slice 04
  may replace the simple directory lock with its measured journal lock, but it
  must preserve serialization and the in-lock manifest generation check. The
  v1 lock is never automatically stolen based on PID, age, corrupt metadata, or
  apparent process death; an unresolved stale lock fails closed and requires
  diagnosis or manual cleanup.
- **Verdict:** Sound. It prevents lost config updates and stale-reader writes
  without making runtime lock state part of the portable format.
- **Confidence:** High.

### Key runtime state by the resolved Git worktree directory

- **When:** Slice 03 linked-worktree review.
- **The choice:** Runtime staging and mutation locks live below a deterministic
  hash of the resolved worktree Git directory inside the Git common runtime
  root. The portable repository identity remains shared, while operational
  state is isolated per worktree. The alternative was one common lock and
  staging directory for every linked worktree.
- **The gap:** The format required separately keyed operational state but did
  not choose the local key material.
- **The reach:** A stale lock or active write in one worktree cannot block an
  unrelated linked worktree. Moving or recreating a worktree may leave
  disposable runtime state under its old key; no portable evidence depends on
  that key.
- **Verdict:** Sound. The resolved Git directory is local, stable for a
  worktree's lifetime, and never enters committed evidence.
- **Confidence:** High.

## Implementation choices — Slice 04 runtime journal

### Use SQLite transactions beside a synced raw-byte CAS

- **When:** Slice 04 engine-selection checkpoint.
- **The choice:** A hook first writes its exact provider bytes to a temporary
  file, syncs them, atomically publishes them by hash, and syncs their directory.
  Only then may a SQLite transaction publish the event row and acknowledge the
  hook. SQLite owns the shared sequence counter, idempotency identities, Stop
  claims, and completions; the raw bytes remain ordinary inspectable files. The
  tested mkdir-lock segmented candidate could also number 200 concurrent
  events, but killing its lock owner left a stale lock. Stealing that lock by
  process ID or age can race a new living owner, while refusing to steal it
  prevents recovery forever. This measurement does not rule out a future
  segmented design with an operating-system-released fence such as `fcntl`.
- **The gap:** The spec explicitly delegated SQLite versus a segmented append
  log until the crash and latency lab measured both concrete candidates.
- **The reach:** All linked worktrees share one Git-common journal and its
  sequence. Bun uses its built-in SQLite binding and Node uses `node:sqlite`, so
  no native addon becomes a release dependency. Runtime SQLite files remain
  disposable and never become portable evidence.
- **Verdict:** Sound, provisionally resolving the human checkpoint. The Docker
  lab passed every SQLite crash boundary and the 8-by-25 contention oracle,
  while producing a concrete stale-lock failure for the segmented alternative.
- **Confidence:** High.

### Advance an explicit counter only for a new idempotency identity

- **When:** Slice 04 journal schema design.
- **The choice:** Suppose a provider retries one event after losing Factory's
  response. Factory hashes the journal's local runtime scope, provider, native
  Session ID, capture generation, and provider event ID into one identity. The
  transaction returns the existing row when every byte and fact agrees, rejects
  conflicting reuse as corruption, and advances `next_sequence` only when it
  inserts a genuinely new identity. A database-generated auto-increment value
  could be consumed by an ignored insert or rolled-back attempt and leave a gap.
- **The gap:** The spec required idempotency and unbroken logical order but did
  not choose the sequence-allocation mechanism or the complete identity tuple.
- **The reach:** Retries, simultaneous hook processes, and linked worktrees all
  preserve an exact zero-based order. Recreating the Git-common runtime starts a
  new local scope rather than confusing unrelated journal lifetimes.
- **Verdict:** Sound. The counter update and event insert share one committed
  transaction, which is the property that rules out phantom sequence numbers.
- **Confidence:** High.

### Bound one capture record and require a SQLite-capable Node 22

- **When:** Slice 04 input and packaging review.
- **The choice:** One raw hook record is limited to 64 MiB, provider/session/
  event identifiers to 4 KiB each, and an operational path to 32 KiB. Inputs
  outside those limits fail through the provider-valid nonblocking hook path
  before sequence allocation. The runtime-journal package requires Node 22.13
  or newer because earlier Node 22 releases do not consistently expose
  `node:sqlite`; Bun uses its built-in binding. One journal lifetime is bounded
  at 100,000 rows, one Turn at 10,000 events, and one claim read at 64 MiB of
  exact raw bytes; reads are sequential and enforce file size before allocation.
  Event metadata and each claim/completion table are limited to 64 MiB in total
  and read in bounded pages; individual claim and completion JSON are limited to
  1 MiB and 128 KiB respectively. A Turn that exceeds its event or raw-byte
  recovery bound is returned as typed unavailable work, so it cannot starve
  ready Stops in other Sessions.
- **The gap:** Unbounded metadata or payloads could exhaust a hook process, and
  the workspace-wide `node >=22` declaration includes releases without the
  selected storage engine.
- **The reach:** A provider event larger than the bound remains a visible
  capture failure rather than partially durable evidence. Release verification
  must exercise exact Node 22.13+ authority; the current host evidence is Node
  24 only.
- **Verdict:** Sound for v1 and aligned with the repository CAS's 64 MiB object
  bound, but the raw limit should move only with measured provider evidence.
- **Confidence:** Medium.

### Make a Stop claim a permanent frozen fence

- **When:** Slice 04 claim/recovery state-machine design.
- **The choice:** Claiming a Stop stores one immutable claim containing the Stop
  identity, its sequence cutoff, and every included event identity. Retrying or
  reopening returns that same claim; completing it records the exact verified
  Turn reference. Factory never expires, steals, or silently replaces a claim
  based on time, process ID, or apparent owner death. Only the transaction that
  creates the claim receives execution authority; concurrent callers receive an
  `already-claimed` observation. A later process resumes the durable claim
  through explicit recovery instead of guessing whether the earlier process was
  still live.
- **The gap:** The API named claims and recovery but did not define lease,
  fencing, or cutoff semantics.
- **The reach:** Slice 06 materialization receives a stable input set across
  crashes and may publish idempotently before completing the claim. New Session
  events after the cutoff belong to a later Turn rather than changing work
  already in progress.
- **Verdict:** Sound. Permanent state plus immutable repository publication
  removes the unsafe ownership inference that a renewable lease would require.
- **Confidence:** High.

### Require repository proof before completing a claim

- **When:** Slice 04 adversarial state-machine review.
- **The choice:** Completion accepts an owned Turn manifest path and hash only
  after a repository-provided capability returns the exact verified immutable
  bytes for that claim. The journal checks those bytes again before committing.
  A path-shaped string and plausible hash are not proof that a Turn exists.
- **The gap:** The original seam accepted a syntactically valid reference, which
  could permanently hide pending recovery work without any committed Turn.
- **The reach:** Slice 06 must connect materialization through the repository
  store's verification boundary. Tests and crash labs create real immutable
  files behind an injected capability rather than inventing Turn references.
- **Verdict:** Sound. Only portable repository truth can retire runtime work.
- **Confidence:** High.

### Resolve one private journal from Git common metadata

- **When:** Slice 04 runtime-path security review.
- **The choice:** Production opening starts from a repository worktree and
  resolves its Git common directory; an arbitrary runtime root is available
  only through an explicitly named test seam. Journal directories are `0700`,
  files are `0600`, owned entries reject symbolic links, and created directory
  entries are synced through the pre-existing Git common parent.
- **The gap:** Accepting an arbitrary production root could silently split
  linked worktrees into multiple authorities, while default filesystem modes
  and path-following could expose provider payloads or redirect writes.
- **The reach:** Repository identity never chooses runtime identity. All linked
  worktrees converge on one local sequence and raw store, while operational
  worktree paths remain routing metadata only.
- **Verdict:** Sound. The API makes the one-journal invariant difficult to
  violate accidentally and keeps sensitive raw capture private.
- **Confidence:** High.

### Keep hook diagnostics private and best-effort

- **When:** Slice 04 nonblocking hook error path.
- **The choice:** The strict append method still throws so callers can diagnose
  a failed durability promise. The hook-facing wrapper catches that error,
  attempts to sync a text diagnostic under Git-common runtime state, and returns
  without throwing even if the diagnostic disk is also unavailable. Provider
  adapters remain responsible for their provider-valid response bytes; the
  journal does not invent a shared Codex/Claude response protocol.
- **The gap:** The spec required a visible but nonblocking hook failure without
  assigning the boundary between storage errors and provider responses.
- **The reach:** Slice 06 can always let the provider Session continue while
  `doctor` gains a private diagnostic to report when storage permitted it.
  Diagnostics are content-addressed so a repeatedly pending item converges on
  one file, and both creation and inspection stop at 10,000 entries. No
  transient failure detail enters committed `.factory` evidence.
- **Verdict:** Sound. It separates the strict durability API from fail-open hook
  control flow and leaves provider vocabulary with its adapter.
- **Confidence:** Medium.

## Implementation choices — Slice 05 Git observation

### Finish observation before publishing repository evidence

- **When:** Slice 05 safe Git observation.
- **The choice:** The observer holds each size-bounded captured file until it
  finishes its ending race check, then writes captured files and the manifest
  through a supplied object store. For example, Slice 06 can observe a source
  tree, learn that a file changed halfway through, and only then publish the
  explicitly partial evidence into `.factory`. The
  alternative was to write CAS objects during the observation window, which
  would make Factory's own new files appear in Git status and blur whether the
  developer's checkout changed.
- **The gap:** The slice fixed a read-only observer API and the repository
  package as the eventual writer, but did not place the publication boundary
  relative to the ending sentinel.
- **The reach:** Capture must connect the object-store seam to the sole
  repository writer and persist the returned observation; it must not move
  `.factory` writes back inside the Git read window. Slice 06 must retain the
  same per-file and aggregate-memory bounds when it connects this observer.
- **Verdict:** Sound. The race result describes only the subject checkout, not
  side effects caused by recording the result.
- **Confidence:** High.

### Do not ask Git to inspect live worktree content

- **When:** Slice 05 hostile-filter verification.
- **The choice:** Factory captures exact worktree files and compares their blob
  identities and modes with the parsed index and HEAD tree. It never asks Git
  to compare live worktree content. A repository can attach a `clean` filter to
  a file; Git runs that program from status and diff-shaped inspections even
  when text conversion and external diff drivers are disabled. The alternative
  would execute repository-configured code during what Factory promises is an
  observation-only operation.
- **The gap:** The format allows optional patch references while the
  security contract forbids executing filters; the plan did not resolve Git's
  behavior when those requirements conflict.
- **The reach:** Review planning derives changes from the exact HEAD tree,
  index, and worktree manifests rather than asking Git to inspect live files.
  A future Git implementation may add a patch only if it proves the same
  no-filter boundary.
- **Verdict:** Sound. Exact bytes remain available and security wins over a
  redundant convenience representation.
- **Confidence:** High.

### Include non-ignored untracked code and label ignored paths as excluded

- **When:** Slice 05 inclusion semantics.
- **The choice:** A workspace snapshot includes every tracked path present in
  the worktree and every untracked path Git does not ignore. An ignored build
  output or secret-shaped local file is not copied, but the manifest says how
  many ignored paths were excluded. The alternative was either to omit all
  untracked work, missing newly authored code, or capture ignored trees that
  Git explicitly treats as outside the source view.
- **The gap:** The slice required tests for both ignored and untracked files but
  did not state their final inclusion rule.
- **The reach:** Workspace reviews see new source before `git add`; ignored
  files are never silently presented as reviewed code. Later configuration can
  widen policy only through an explicit format change.
- **Verdict:** Sound. It matches the workspace users recognize from ordinary
  Git status while keeping exclusions visible.
- **Confidence:** Medium.

### Keep `.factory` evidence outside the code snapshot

- **When:** Slice 05 workspace inclusion review.
- **The choice:** The code manifest excludes the complete `.factory` namespace,
  including `.factory/skills`. Review bundles inventory Factory evidence and
  selected skills through their own explicit inputs; they do not recursively
  capture that evidence as if it were application source. The alternative made
  each observation include prior observations and reviews, so snapshots would
  grow through self-reference and a newly recorded object could create a false
  repository race.
- **The gap:** The plan protected unknown `.factory` content but did not state
  whether foreign content below that namespace also belonged in a workspace
  code snapshot.
- **The reach:** Slice 08 must select `.factory/skills` deliberately when skills
  are review inputs. It cannot rely on the code manifest to smuggle them into a
  bundle.
- **Verdict:** Sound. One namespace has one role, and review inputs remain
  inspectable instead of recursive.
- **Confidence:** High.

### Refuse unsafe or cyclic links before reconstructing any entry

- **When:** Slice 05 reconstruction policy.
- **The choice:** Factory preserves every symbolic-link target as raw bytes in
  the manifest, then preflights the complete link graph before writing a fresh
  reconstruction. A link that escapes the destination or a pair of links that
  point in a cycle makes reconstruction fail before ordinary files are written.
  The alternative was a half-built directory or a reconstruction containing a
  link that could make a later reviewer read outside its bundle.
- **The gap:** The slice required safe, unsafe, and cyclic link coverage but did
  not define whether unsupported links should be materialized, skipped, or
  reject the reconstruction.
- **The reach:** Bundle creation must treat these manifests as typed partial
  evidence and may still review their readable objects, but it cannot expose an
  unsafe filesystem tree to the reviewer.
- **Verdict:** Sound. Raw evidence stays lossless while reconstructed authority
  stays confined.
- **Confidence:** High.

### Treat a failed reconstruction destination as disposable

- **When:** Slice 05 concurrent reconstruction hardening.
- **The choice:** Factory closes its bound descriptors but does not unlink any
  pathname after reconstruction fails. The caller must discard the whole
  destination and never consume it as a snapshot. The alternative was
  best-effort cleanup after comparing an entry's inode and type.
- **The gap:** POSIX unlink is pathname-based, so another process can replace an
  entry after its identity check and before deletion. There is no portable
  identity-conditional unlink that makes that cleanup safe.
- **The reach:** Failed destinations may retain partial manifest entries or
  concurrent foreign entries. Callers must allocate disposable destinations;
  successful reconstruction still requires a bounded, exact post-write
  inventory before any consumer receives the tree.
- **Verdict:** Sound. Never deleting potentially foreign data is more important
  than tidying a destination that cannot be trusted after failure.
- **Confidence:** High.

### Make the review trigger the Turn publication commit point

- **When:** Slice 06 crash-recovery design.
- **The choice:** The repository creates deterministic immutable Turn records
  object-first and the review trigger last. Readers expose only a complete
  trigger-linked graph. A crash may leave an immutable physical prefix, which
  explicit repair either converges byte-for-byte or diagnoses as corrupt.
- **The gap:** A portable filesystem cannot atomically rename a graph spread
  across several existing directories, while per-file create-only writes are
  necessary for convergence.
- **The reach:** “No partial Session” means no partial Session in the public
  projection, not that an interrupted disk can never contain unreachable files.
  Recovery retires a claim only after reconstructing the exact deterministic
  trigger, event, transcript, observation, and object inventory graph; a merely
  schema-valid rewrite remains pending and is diagnosed. Fresh publication,
  prefix resumption, and completion proof derive limitations from the same
  frozen claim and durable observation/transcript graph, so a crash boundary
  cannot change whether evidence is complete or partial.
- **Verdict:** Sound. The logical boundary is explicit, testable, and rebuilds
  without private indexes.
- **Confidence:** High.

### Treat provider generation zero as the v1 native Session generation

- **When:** Slice 06 provider identity mapping.
- **The choice:** Codex and Claude events enter v1 as generation zero because
  neither proved hook surface supplies a native generation. Generation remains
  in every key and schema so a future provider signal can advance it without
  conflating Sessions.
- **The gap:** The public format has a generation field, but current provider
  hook evidence has no authoritative reset counter.
- **The reach:** Reuse of the same native Session ID is first-writer identity in
  v1. Factory must not infer a new generation from time, branch, or repository.
- **Verdict:** Sound with an explicit limitation; invented generation would be
  less trustworthy than a documented zero convention.
- **Confidence:** Medium.

### Keep hook removal authority in private exact fingerprints

- **When:** Slice 06 installation reconciliation.
- **The choice:** Provider hook groups stay provider-native. Factory records the
  exact provider/event/group fingerprints it installed in private global state,
  and only those prior fingerprints authorize replacement or removal.
- **The gap:** An embedded ownership marker can violate provider schemas, while
  command-shape matching can steal an identical foreign hook.
- **The reach:** A user-edited former Factory entry becomes foreign and survives
  uninstall. Interrupted config/state writes converge through a private
  transaction record tied to the expected provider path.
- **Verdict:** Sound. Ownership is narrow without extending provider schemas.
- **Confidence:** High.

### Keep parsed hook payloads out of durable Turn envelopes

- **When:** Slice 06 structured-record bound review.
- **The choice:** `events.jsonl` inventories the durable raw hook objects and
  their observation order, but does not duplicate provider JSON as parsed
  convenience data. Exact provider bytes remain canonical in the object store.
- **The gap:** One hook may be tens of MiB and one Turn may contain thousands of
  hooks; duplicating parsed values could create a structured record that the
  bounded repository reader must refuse.
- **The reach:** Later analyzers parse selected bounded raw objects from the CAS.
  They cannot treat a convenience projection as stronger evidence than the raw
  provider input.
- **Verdict:** Sound. It removes duplication and guarantees the public graph can
  be rebuilt within its declared record limits.
- **Confidence:** High.

### Route linked-worktree evidence to the worktree that produced it

- **When:** Slice 06 linked-worktree recovery review.
- **The choice:** A Session keeps the first repository identity as its owner,
  while each Stop and SessionEnd is observed and published in the exact linked
  worktree recorded by the provider event. Factory accepts that route only when
  Git-common identity and the portable repository ID both match. Private
  completion state freezes the destination worktree and repository ID so later
  recovery verifies the same immutable record.
- **The gap:** Git-common identity proves linked checkout membership, but an
  older branch can predate `.factory`; publishing its code evidence into the
  owner's different branch would misrepresent the observed state.
- **The reach:** A linked checkout without the matching portable manifest stays
  pending and is diagnosed. Repair from any matching linked checkout can resume
  the shared journal without searching arbitrary repositories or publishing on
  the wrong branch.
- **Verdict:** Sound. Repository ownership stays singular while portable
  evidence remains beside the exact code state it describes.
- **Confidence:** High.

### Group GitHub history by provider identity, not its current name

- **When:** Slice 07 pull-request identity design.
- **The choice:** A repository key hashes the lowercase GitHub hostname with
  GitHub's stable repository node ID. If `owner/widget` is renamed to
  `company/widget`, both observations keep one key; a fork has another node ID,
  and an enterprise server with the same ID has another hostname and therefore
  another key. The observation also freezes the human-readable owner/name and
  PR URL from that moment. One attempt keeps the first stable base identity it
  observes; a later conflicting identity fails under that first key instead of
  moving evidence to the last value. Before `gh` reveals a node ID—because it
  is missing or unauthenticated—the failed attempt stays a typed runtime result
  instead of being filed under a name-derived key that merely looks stable.
- **The gap:** The plan required stable repository identity, rename, fork, and
  GHES behavior but did not choose its path-safe representation or say where a
  pre-identity failure belongs.
- **The reach:** PR reviews and the UI group immutable history across renames
  without conflating forks or GitHub installations. A missing-`gh` attempt is
  diagnosable but cannot create misleading portable identity.
- **Verdict:** Sound. Provider identity owns grouping while observed locators
  keep committed evidence understandable offline.
- **Confidence:** High.

### Preserve a coherent PR diff when bounded metadata is partial

- **When:** Slice 07 bounded GitHub observation.
- **The choice:** Factory reads metadata and every commit page, reads the exact
  patch, then repeats the same bounded metadata/commit read. Matching views
  publish their shared exact facts and readable patch. Complete membership is
  distinct from a bounded prefix, and deleted fork/ref facts are explicitly
  absent. Optional code capture separately records captured, unavailable, or
  not-requested state. Provider errors, mutation, malformed responses, and a
  missing coherent diff remain unavailable.
- **The gap:** The slice delegated bounded `gh` mechanics but did not define a
  coherent read across several provider calls or what a capped commit list
  means for exactness.
- **The reach:** Association and bundle planning may trust every available
  observation as one coherent provider snapshot. Large PRs and deleted forks
  remain reviewable now, while their explicit limits disable unsafe membership
  and absence inference.
- **Verdict:** Sound. The type preserves best-effort review without allowing a
  partial commit list to look complete.
- **Confidence:** High.

### Treat exact fork commits as proof and manual inclusion as an assertion

- **When:** Slice 07 association fold.
- **The choice:** A Session is automatically associated when its observed Git
  head is exactly the PR head or one member of a complete PR commit set. The
  source is a validated Turn joined to its named
  stable RepositoryObservation, never caller-supplied Session/HEAD fields. A
  provider-derived repository mapping classifies base versus different when it
  is unique, but never gates an exact SHA match. A branch name, nearby time,
  matching paths, or worktree never substitutes for proof. A human may include
  a Session manually, but the record says `asserted`, names the actor and
  reason, and is never called verified. If a force-push later removes the proof
  SHA, Factory appends an
  invalidation that points at the old evidence; the old record remains.
- **The gap:** The initial schema had no manual variant, a vague `strong`
  strength, and no representable invalidation fact. The plan also did not say
  whether exact evidence captured in a fork should survive the repository
  identity check.
- **The reach:** One Session can contribute to several PRs and one PR can carry
  several Sessions without an Epic or branch grouping. Future continuity work
  must add a separately proven evidence kind; it cannot broaden this exact fold
  by stealth.
- **Verdict:** Sound. The record tells downstream readers which facts were
  machine-proved, human-asserted, or later invalidated.
- **Confidence:** High.

### Publish association evidence through immutable completion batches

- **When:** Slice 07 crash-consistency review.
- **The choice:** Association records are physical prefixes until a final
  immutable batch pins their hashes, PR observation, source observations,
  timestamp, and policy. Automatic evidence and each manual action time publish
  as separate deterministic batches. Readers validate every named record and
  ignore uncommitted prefixes.
- **The gap:** Append-only files prevent partial overwrite but do not make a
  multi-record derivation logically atomic across a process crash.
- **The reach:** Retry converges without deletion. Orphans remain inspectable
  yet cannot silently enter review planning.
- **Verdict:** Sound. It uses the same explicit commit-point principle as Turn
  capture while preserving immutable history.
- **Confidence:** High.

### Snapshot review records, but fetch content-addressed objects only when named

- **When:** Slice 08 repository input loading.
- **The choice:** When review planning starts, Factory opens the repository's
  `.factory` directory through confined filesystem descriptors and freezes the
  review-owned record bytes it discovers. It does not scan the accumulated
  content-addressed object store. Instead, a record must name an object by its
  hash and byte length before Factory opens that exact object. For example, a
  repository may contain years of unrelated captured blobs; planning one
  Session freezes the relevant trigger and Turn records, then reads only the
  blobs those records reference. A second inventory comparison rejects a
  record tree that changed while the snapshot was being frozen.
- **The gap:** The plan required bounded, immutable inputs but did not decide
  whether that meant snapshotting every stored object, holding filesystem
  descriptors open through the whole review, or copying only named evidence.
- **The reach:** Large repositories do not make every review proportional to
  all historical CAS data. The tradeoff is a bounded in-memory copy of record
  metadata during planning; future streaming work must preserve the same
  immutable-snapshot guarantee rather than reopening mutable paths.
- **Verdict:** Sound. Discovery stays complete for review-owned records while
  expensive object work remains driven by validated references.
- **Confidence:** High.

### Apply the Session cap after complete trigger discovery but before graph loading

- **When:** Slice 08 bounded candidate acquisition.
- **The choice:** Factory first inventories every trigger record, so a caller
  cannot hide a pending Stop by passing a shorter list. It then admits only the
  configured number of Session identities for full Turn, transcript, and object
  verification; remaining valid triggers are reported as deferred-by-limit and
  drain in later runs. With `--session`, valid triggers for other Sessions are
  excluded only after this complete discovery. A corrupt trigger that cannot
  safely reveal its Session stays visible as a diagnostic, but it does not make
  the named Session's review partial because Factory cannot prove the link.
- **The gap:** The plan fixed both complete discovery and a `maxSessions` work
  bound, but did not specify where the bound falls or how an unreadable trigger
  behaves under an exact Session filter.
- **The reach:** Review work remains bounded without turning the limit into an
  omission attack. Future scheduling may improve admission priority, but it
  cannot treat deferred evidence as reviewed or let an unassignable corrupt
  record block an unrelated named Session.
- **Verdict:** Sound. The status preserves the difference between discovered,
  admitted, reviewed, and merely diagnostic evidence.
- **Confidence:** Medium.

### Validate historical limitation ownership without importing old code into the review

- **When:** Slice 08 portable history and bundle verification.
- **The choice:** A prior review may say an optional object was missing from a
  code manifest. Factory loads the exact historical code-manifest bytes to
  prove that the manifest really named that limitation object. It bundles that
  validation root so the proof works offline, but it does not recursively add
  the historical source tree to the current reviewer's inputs. For example, a
  current PR review can prove why an old workspace review was partial without
  silently exposing all files from that old workspace snapshot.
- **The gap:** The plan required both restart-safe history validation and a
  minimal reviewer bundle, but did not say whether historical provenance roots
  recursively become current reviewer dependencies.
- **The reach:** History cannot forge ownership of a missing object, and current
  review visibility does not expand merely because coverage consulted an old
  manifest. Any future historical evidence shown to the model must be selected
  explicitly rather than arriving through generic object traversal.
- **Verdict:** Sound. Validation authority and reviewer visibility remain
  separate, explicit concerns.
- **Confidence:** High.

## Implementation choices — review execution

### Pin effective model and effort before planning

- **When:** Slice 09 review identity contract.
- **The choice:** Review execution requires one complete reviewer identity
  before it freezes the review plan. The deterministic journey supplies exact
  fixture settings; production execution stays disabled until versioned Factory
  defaults are chosen. For example, a future automatic Codex review must record
  the exact Codex model and effort Factory requested; it must never write a
  placeholder that means “whatever the provider chose today.” If the installed
  client cannot force or report those settings, that reviewer is unavailable
  rather than reproducible by guesswork.
- **The gap:** The spec required manifests to pin model and effort but the
  initial shared reviewer type made both optional and did not say when defaults
  became evidence.
- **The reach:** Policy identity, bundle hashes, retries, and later comparisons
  all use the same resolved settings. Changing a Factory default becomes an
  explicit policy change that schedules a new current-code review.
- **Verdict:** Sound. Reproduction depends on exact requested settings, not
  mutable server defaults.
- **Confidence:** High.

### Prefer Codex when an automatic review has no authoring Stop

- **When:** Slice 09 automatic reviewer selection.
- **The choice:** A subject-only review can have no exact Session Stop to name
  an authoring provider. In that case Factory tries the versioned Codex reviewer
  first, then Claude when only Claude is authenticated. This is only the
  no-context tie-breaker: when an exact Stop exists, Factory still prefers the
  other harness and falls back to a fresh Session of the same harness. Weak
  same-branch context never changes the choice.
- **The gap:** The product fixed cross-harness selection from the newest Stop
  but did not define `reviewer:auto` when a current-code or PR-diff review has no
  selected Stop.
- **The reach:** Subject-only reviews remain deterministic. Reversing the
  preference is a one-constant policy change and must refresh the plan identity.
- **Verdict:** Needs-user. Codex-first is the reversible provisional choice; a
  product-level preferred harness can replace it before release.
- **Confidence:** Low.

### Keep provider credentials host-owned without changing their private mode

- **When:** Slice 09 reviewer authentication boundary.
- **The choice:** Factory gives the reviewer container one dedicated, read-only
  credential file. If it is mode `0600`, Factory validates that the invoking
  non-root developer owns it and runs the container as that numeric owner UID
  with a fixed unprivileged group. The file remains provider-owned and unchanged. Root-owned or
  foreign-owned files are unavailable. The rejected alternative would copy the
  secret into a temporary file, loosen permissions, pass token environment
  variables, or bridge a host keyring.
- **The gap:** The plan required read-only authentication and prohibited
  developer credentials in tests, but it did not authorize secret staging or a
  keyring bridge for production.
- **The reach:** Ordinary private file credentials can cross Docker Desktop and
  Linux bind mounts without a second secret copy. Keyring-only authentication
  remains unavailable. Future work cannot make review “just work” by weakening
  permissions or borrowing a broader host credential surface.
- **Verdict:** Sound. Unavailability preserves the documented trust boundary;
  a usable secret handoff is a security feature, not an implementation detail.
- **Confidence:** High.

### Keep one crash-recovery identity in Git-common runtime state

- **When:** Slice 09 concurrent execution and acceptance recovery.
- **The choice:** Every logical attempt is keyed by the verified bundle,
  reviewer settings, image, and policy versions in the Git common directory,
  which is private runtime storage shared by linked worktrees. The first caller
  records a time-sortable review ID and deterministic container ownership before
  Docker starts. Concurrent callers wait on that same attempt. After the review
  becomes immutable history, Factory replaces the cached raw response with a
  small finalized marker. For example, if one process accepts a review and a
  stale second process arrives afterward, the marker prevents a second model
  run without retaining the provider's response forever.
- **The gap:** The plan required retries, crashes, and concurrent invocations to
  converge, but it did not choose the durable single-flight key or what remains
  after acceptance.
- **The reach:** Linked worktrees cannot accidentally run the same logical
  review twice, crash recovery can remove only the exact labeled container, and
  portable `.factory` data stays free of locks and transient logs. Changing the
  attempt identity changes retry semantics and must preserve the finalized
  marker's no-rerun guarantee.
- **Verdict:** Sound. It separates portable immutable truth from recoverable
  machine-local coordination while bounding retained sensitive data.
- **Confidence:** High.

### Leave production review execution disabled until its authority is packaged

- **When:** Slice 09 CLI journey integration.
- **The choice:** The installed command validates review flags and supports the
  zero-Docker partial-coverage acceptance path, but ordinary model execution
  currently fails closed. A deterministic test-only journey supplies a pinned
  fake image, explicit reviewer settings, and a frozen fixture subject. The
  unbuilt production path must first capture the exact current workspace or PR,
  ship a pinned reviewer image, and choose versioned product defaults; it must
  not silently select the newest-looking stored observation or treat developer
  environment variables as product configuration.
- **The gap:** The slice specifies execution after a verified bundle, while the
  packaging/default choice and fresh CLI subject-observation wiring belong to
  adjacent product work and were not settled here.
- **The reach:** This branch proves the execution and acceptance boundaries but
  does not yet make `factory review` a usable production command. Enabling it
  later requires deleting the test gate only after fresh subject capture and
  packaged authority reach the same release-shaped journey.
- **Verdict:** Needs-user. Keep the fail-closed gate as the reversible
  provisional call; choose the shipped image, model defaults, and credential
  handoff before enabling production execution.
- **Confidence:** Low.
