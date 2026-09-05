# Factory v1 choices

This records choices in the implemented design, not a build log or a second schema.
The public format and the responsible implementation own exact mechanics.
The choices below describe behavior the user now owns; verification results
belong in the specification's evidence reports.

Review these first: the no-context reviewer preference, human-only decision
actions, and what happens after an automatic review fails. The provisional
recommendations below are implemented defaults, not requests to pause work.

## Needs-user — low confidence

### Prefer Codex when no exact authoring Stop can choose the reviewer

- **When:** Review execution and automatic reviewer selection.
- **The choice:** A user asks for a PR review with no captured coding Session.
  There is no exact Stop—the provider's end-of-turn event—to identify who wrote
  the code. With reviewer selection set to `auto`, Factory tries Codex first,
  then Claude when only Claude is authenticated. When exact selected Stop
  evidence exists, Factory instead prefers the other coding harness and falls
  back to a fresh Session of the same harness. Merely sharing a branch does
  not choose the reviewer. This applies to manual commands too; `auto` here
  means provider selection, not background scheduling.
- **The gap:** Cross-harness review was chosen, but its no-author tie-breaker
  was not.
- **The reach:** Subject-only reviews acquire a predictable provider preference
  rather than depending on discovery order.
- **Verdict:** Needs-user. Keep Codex-first provisionally; reversing the
  preference is an explicit reviewer-policy change, not a history rewrite.
- **Confidence:** Low.

### Let models propose decisions but reserve decision actions for humans

- **When:** Decision-action authority design.
- **The choice:** A reviewer observes that a feature changes the database
  choice. That observation can become a pending proposal, but the reviewer
  cannot confirm it, reject it, open or resolve a human dispute, or supersede
  an existing decision. Those actions require a human actor. The alternative
  would let the analyzer promote its own conclusions into the accepted view.
  Factory removed the otherwise inert automatic-confirmation setting rather
  than pretending that a boolean defined that authority.
- **The gap:** The original action vocabulary did not specify which actors
  could perform each action.
- **The reach:** Future automatic approval needs an explicit policy and action
  authority; it cannot arrive through a hidden confidence threshold.
- **Verdict:** Needs-user. Retain human-only actions provisionally. Automation
  can be added later with a deliberately narrower, inspectable contract.
- **Confidence:** Low.

## Needs-user — medium confidence

### Pin reviewer settings, with explicit product defaults

- **When:** Review identity contract.
- **The choice:** Before a review is planned, Factory resolves the provider,
  model, and effort and writes that requested identity into the immutable
  attempt. Its defaults are Codex `gpt-5.6-sol` at `xhigh` and Claude
  `claude-opus-5` at `high`; explicit supported overrides replace them. A later
  review does not reinterpret an old manifest as whatever model the provider
  happens to default to today. The adapter passes model and effort explicitly
  to the selected CLI and rejects unsupported effort values. This records
  requested identity, not an independent attestation of the model service's
  actual execution; Factory does not verify a provider-reported effective
  model/effort against the request.
- **The gap:** Exact model identity was required, but the quality, latency, and
  cost defaults were not selected by the user.
- **The reach:** Changing defaults is a versioned policy change and can require
  a fresh current-code review. Existing evidence keeps its original identity.
- **Verdict:** Needs-user. Keep these explicit defaults provisionally; change
  the versioned defaults when a different cost/quality balance is preferred.
- **Confidence:** Medium.

### Do not automatically retry an unchanged failed review

- **When:** Automatic-review completion, `3b4de63`.
- **The choice:** A Stop creates review work while Docker or authentication is
  unavailable. Factory records the failed attempt or a private diagnostic, then
  avoids repeatedly trying the same pending trigger set on every hook. A
  trigger is the durable request created by a Stop. Repairing login or changing
  settings alone does not restart that unchanged set: the user can run a manual
  review, or a new Stop can wake another attempt. A private fixed-size hash of
  pending trigger IDs also suppresses failures that occurred before a review
  manifest could be written. It never marks evidence accepted, and manual
  review does not consult it.

  ```text
  if pending triggers equal the last attempted set: stop automatic work
  otherwise: attempt review and remember the attempted set
  manual review: use review coverage, not this scheduling memory
  ```

- **The gap:** Opt-in scheduling did not define retry frequency or what to do
  when no portable attempt could be published.
- **The reach:** Background work avoids repeated model costs and error storms,
  at the cost of requiring new evidence or an explicit retry after repair.
- **Verdict:** Needs-user. Retain the anti-loop rule provisionally. A future
  retry policy should be explicitly bounded; it must not redefine coverage or
  blindly retry on every hook.
- **Confidence:** Medium.

### Resolving a dispute closes the dispute, not the underlying argument

- **When:** Decision dispute semantics.
- **The choice:** A user disputes a confirmed observation, then records
  `resolve` with a note. Factory restores that exact observation's human status
  from before the dispute. Resolve does not decide that a replacement assertion
  won. Rejecting the old observation or explicitly superseding it records that
  substantive outcome separately. The alternative was one overloaded resolve
  action whose meaning depended on prose in its note.
- **The gap:** The action was named without specifying dismissal versus
  adjudication.
- **The reach:** A resolution remains simple and reversible, but cannot alone
  encode that the objection was upheld.
- **Verdict:** Needs-user. Keep closure-only resolution provisionally. Add an
  explicit outcome contract if product feedback needs combined adjudication.
- **Confidence:** Medium.

## Sound — medium confidence

### Keep empty attempt locks after deleting execution state

- **When:** Attempt ownership consolidation, `d4ac155`.
- **The choice:** Two commands find the same accepted review attempt. Both
  acquire one lock file outside its disposable directory. The first verifies
  acceptance and deletes transient state while holding that lock; the second
  then sees absence and succeeds without deleting anything. Creation and crash
  recovery use that same lock. Deleting it with the directory could leave an
  existing waiter locking the old filesystem object while a new caller locks
  a replacement at the same pathname, giving both apparent ownership.
- **The gap:** Cleanup ownership had been defined while attempt state existed,
  but not after deleting the resource that contained the lock itself.
- **The reach:** One empty private file remains per distinct attempt key. It
  contains no credential or response and does not count as an active attempt,
  but its small machine-local inode footprint grows with distinct attempts.
  Ordinary cleanup must not remove these identity anchors; independent attempt
  keys remain independently locked.
- **Verdict:** Sound. Stable lock identity trades empty-file retention for
  concurrent correctness without globally serializing all review execution.
- **Confidence:** Medium.

### Stop reading oversized code instead of hashing bytes that cannot be reviewed

- **When:** Bounded Git observation, `e79b8ae`.
- **The choice:** A tracked file is larger than the configured capture bound.
  Factory excludes its content without reading it all merely to compute a
  fingerprint. If a file grows during a read, Factory reads at most the bound
  plus the byte needed to detect overflow, then stops. The repository race
  sentinel—the before/after comparison—uses file identity, size, timestamps,
  and mode for excluded content, not a purported content hash. Without captured
  bytes it also does not claim an exact Git-content comparison for that file.
- **The gap:** Bounded retained memory alone allowed unbounded I/O, and the
  plan did not define what identity remained when bytes were inadmissible.
- **The reach:** Huge files cannot force unlimited hashing through either the
  main capture or race check. Their metadata is only an observation; it cannot
  prove exact content equality or turn excluded content into reviewed evidence.
- **Verdict:** Sound. The work bound applies to reading, not only allocation,
  while explicit exclusions preserve the limit of the claim.
- **Confidence:** Medium.

### Refresh update knowledge explicitly; startup only repeats recent knowledge

- **When:** Configuration completion, `3a0d79a`.
- **The choice:** A user runs `factory upgrade --check` to ask which stable
  Factory release is latest. Factory makes an anonymous request to the fixed
  public `dzhng/factory` GitHub release endpoint, refuses redirects, and bounds
  the response to three seconds and 64 KiB. It stores only the version and
  observation time in a private cache. For seven days, ordinary commands can
  warn on stderr if that cached version is newer; startup does not refresh it
  or install anything. Capture and automatic-review workers skip update
  warnings entirely. Effective `updateChecks: false` disables both explicit
  discovery and warnings. A no-release response replaces old knowledge with
  an empty observation; a transient discovery failure leaves the cache alone.

  ```text
  explicit upgrade --check + enabled preference -> fetch and cache observation
  ordinary command + enabled preference -> read cache only
  missing, stale, invalid, or non-newer cached version -> no warning
  capture or automatic review -> no update-warning work
  ```

- **The gap:** Cached warnings were specified without their refresh trigger,
  freshness period, discovery limits, or failure behavior.
- **The reach:** A fresh installation learns no update version until an
  explicit check; there is no hidden updater lifecycle. A cache entry can never
  authorize executable replacement, which retains its separate verifier.
- **Verdict:** Sound. This keeps offline startup and bounded discovery simple.
  The explicit refresh and seven-day freshness are reversible product defaults.
- **Confidence:** Medium.

### Merge resource settings individually without making isolation optional

- **When:** Configuration completion, `3a0d79a`.
- **The choice:** A user sets a global memory ceiling, while a repository
  changes only CPU allocation. The repository inherits the memory value rather
  than replacing the entire limits object; a manual review flag can override
  one field for that invocation. Defaults are 2 GiB memory, two CPUs, 256
  processes, and ten minutes. Schema validation admits only bounded positive
  integers. Before provider startup, Docker's observed memory, CPU, process,
  and no-extra-swap settings must equal the requested values. The host's review
  execution deadline includes setup such as image acquisition, and it cleans
  up the owned container when execution is interrupted.
- **The gap:** Configurable limits lacked units, defaults, bounded ranges,
  partial-object precedence, and an explicit distinction from isolation policy.
- **The reach:** Per-field flag-over-repository-over-global precedence lets a
  large legitimate workload request larger bounded allocations. These settings
  do not change mounts, user identity, privileges, read-only filesystems, or
  network policy, and are not recorded as a new portable review-policy identity.
- **Verdict:** Sound. Independent resource knobs merge independently; observed
  enforcement prevents configuration text from posing as actual confinement.
  The defaults remain explicit, reversible allocations rather than a claim
  that every workload fits them.
- **Confidence:** Medium.

### Keep shared compiler policy in the root and prose out of source formatting

- **When:** Workspace bootstrap.
- **The choice:** A new package extends the root TypeScript configuration and
  adds only genuine environment differences. It does not depend on a workspace
  whose sole job is to re-export compiler settings. Source formatting checks
  code and structured configuration, while Markdown remains a separately
  reviewed surface. Running a formatter for a small code change therefore does
  not reflow the specification and skill documents beside it.
- **The gap:** Shared type policy and formatting gates were required, but their
  ownership and prose boundary were not fixed.
- **The reach:** New packages inherit one type policy; documentation correctness
  remains a review obligation rather than a side effect of source formatting.
- **Verdict:** Sound. The policy avoids empty abstractions and unrelated prose
  churn without weakening code checks.
- **Confidence:** Medium.

### Keep executable public schemas beside their TypeScript types

- **When:** Public-format implementation and reconciliation.
- **The choice:** A reader loading a Turn uses the public contract package's
  type, validator, canonical encoding, and owned-path rules. Factory does not
  maintain a generated parallel schema or inherit a validation library's
  coercion defaults. Immutable records carry their version. Mutable
  `.factory/config.json` is the deliberate exception: its interpretation comes
  from the root manifest, and unknown configuration fields survive updates.
- **The gap:** One schema authority was required, but the library and mutable
  configuration versioning mechanism were not specified.
- **The reach:** Public field changes must update type and validation together.
  An incompatible config change must advance the root reader requirement, not
  create an unlaunched migration layer.
- **Verdict:** Sound. There is one inspectable format authority and one
  compatibility gate.
- **Confidence:** Medium.

### Bound capture and recovery without silently truncating canonical bytes

- **When:** Repository object store and runtime-journal input design.
- **The choice:** An oversized provider event is refused through the
  nonblocking hook error path rather than cut down and labeled complete. The
  default object and raw-event boundary is 64 MiB; journal metadata, record
  counts, and per-Turn recovery work have separate enforced limits. Reads check
  size before allocation and process bounded pages or chunks. If one Turn is
  too large to recover, it remains visibly unavailable while other ready Stops
  can proceed. The alternative was unbounded input or one bad Session
  permanently starving unrelated recovery.
- **The gap:** The product required bounded work but did not choose initial
  safety limits or their refusal behavior.
- **The reach:** Larger provider evidence requires an explicit segmentation or
  measured limit decision. A limit does not authorize dropping bytes while
  claiming lossless capture.
- **Verdict:** Sound. Limits are explicit operational boundaries and failures
  remain distinguishable from complete evidence.
- **Confidence:** Medium.

### Include new source before staging, but not ignored files

- **When:** Workspace observation inclusion design.
- **The choice:** A developer creates a source file without running `git add`.
  The workspace snapshot includes it if Git does not ignore it, alongside
  tracked files that are present. Ignored output and ignored local files are
  excluded, and the manifest reports their exclusion. The alternative was to
  miss new source until staging or silently pull ignored trees into review.
- **The gap:** The tests named tracked, untracked, and ignored paths without
  fixing their inclusion rule.
- **The reach:** Workspace review matches the source work users expect, while
  the evidence does not pretend excluded files were inspected.
- **Verdict:** Sound. Inclusion is explicit and does not require changing Git
  state to make new code reviewable.
- **Confidence:** Medium.

### Use generation zero when providers supply no native reset counter

- **When:** Provider Session identity mapping.
- **The choice:** Two hooks with the same provider-native Session ID are mapped
  into that Session's generation zero. Factory does not manufacture a new
  generation because the branch changed or enough time passed. Generation
  remains in the schema and identity so a future authoritative provider reset
  signal can use it. The alternative was a heuristic that could split one
  Session or merge reused identities unpredictably.
- **The gap:** The format allowed generations, but observed provider hooks did
  not supply an authoritative generation counter.
- **The reach:** Reuse of a native Session ID is first-writer identity in v1;
  future providers need explicit evidence to advance it.
- **Verdict:** Sound with an explicit limitation. A documented convention is
  more honest than an invented reset signal.
- **Confidence:** Medium.

### Apply the incremental Session cap only to unsettled evidence

- **When:** Candidate acquisition and correction `f262081`.
- **The choice:** Sessions A and B were reviewed; C is new; the limit is two.
  Factory discovers all trigger records, computes accepted coverage, and admits
  C without reopening A and B's evidence graphs or spending the next batch on
  them. Covered triggers remain visible as covered. Full and force reviews
  explicitly reacquire covered evidence. Other pending Sessions are visibly
  deferred, not treated as reviewed. An unreadable trigger that cannot identify
  its Session remains diagnostic; an exact Session filter does not invent a
  connection to it.
- **The gap:** Complete discovery and bounded graph loading were both required,
  but their ordering relative to accepted coverage was unspecified.
- **The reach:** Incremental runs make forward progress without hiding pending
  Stops or turning a limit into review coverage.
- **Verdict:** Sound. Discovery, admission, analysis, and acceptance remain
  different facts.
- **Confidence:** Medium.

### Replay decision history by stored event time with explicit tie-breakers

- **When:** Deterministic decision fold.
- **The choice:** Two clones discover the same observations and actions in
  different filesystem orders. Both replay by the records' stored timestamps;
  observations precede actions at the same time, then record IDs break ties.
  Neither directory enumeration nor discovery time decides which action
  happened first. Late discovery reconstructs the same history from the same
  records rather than appending a new interpretation at the end.
- **The gap:** Replay had to be deterministic, but its ordering rule was not
  selected.
- **The reach:** Action validity has one inspectable ordering across machines;
  timestamps are recorded evidence, not an assertion of a perfect global clock.
- **Verdict:** Sound. Explicit tie-breakers make equal input reproducible.
- **Confidence:** Medium.

## Sound — high confidence

### Pin one toolchain and make build mean distributable output

- **When:** Workspace bootstrap and runtime reconciliation.
- **The choice:** A fresh clone and its Docker gates use the same exact pinned
  development runtime and tools. A package build emits distributable JavaScript
  and declarations; type checking remains a separate no-output check. A
  compiler passing without producing a package therefore cannot masquerade as
  a successful build. Dependency updates deliberately move the shared pins.
- **The gap:** The plan named tools and separate gates, but not every version
  or whether both commands could merely type-check.
- **The reach:** Release verification can exercise actual built artifacts and
  does not accidentally compare different host/container toolchains.
- **Verdict:** Sound. Reproducible tools and distinct build/type contracts
  prevent a misleading green gate.
- **Confidence:** High.

### Publish immutable files atomically outside the portable staging namespace

- **When:** Repository writer design.
- **The choice:** Factory stages a complete immutable record in private Git
  runtime storage and publishes it with a create-only hard link. Two writers
  producing identical bytes converge; different bytes at the same owned path
  fail. Mutable config uses an atomic replacement instead. V1 refuses a
  worktree/Git-metadata arrangement where these operations cross filesystems,
  rather than falling back to partial writes or leaving temporary files inside
  committed `.factory` data.
- **The gap:** Atomic create-only records were required, but staging location,
  publication primitive, and split-filesystem behavior were unspecified.
- **The reach:** Every portable record inherits the same no-overwrite property.
  Supporting split filesystems requires a newly proven publication mechanism.
- **Verdict:** Sound. The explicit limitation preserves immutability and keeps
  crash debris out of portable evidence.
- **Confidence:** High.

### Serialize mutations and recheck the manifest after acquiring ownership

- **When:** Repository concurrency design and advisory-lock replacement.
- **The choice:** Two commands update different config fields at once. Each
  acquires the same worktree mutation lock, then rereads the manifest and merges
  against current config before publishing. The lock is an operating-system
  advisory lock released when its process dies, not a directory that must be
  stolen based on age or PID. A store opened before Git changed its manifest
  cannot write through stale format authority.
- **The gap:** Atomic individual files alone did not prevent lost config fields
  or stale-reader mutations.
- **The reach:** All writers share serialization and compatibility checks;
  crash recovery does not require guessing whether a lock owner is alive.
- **Verdict:** Sound. The lock protects the whole read-modify-write contract.
- **Confidence:** High.

### Separate per-worktree staging from the shared capture journal

- **When:** Linked-worktree runtime design.
- **The choice:** Two linked worktrees share one Git repository and one private
  capture journal, so their hook events have one ordering. Their repository
  mutation staging and locks are separately keyed by each resolved worktree Git
  directory, so a write in one checkout does not globally serialize unrelated
  portable writes in the other. These local keys and paths never enter portable
  identity. Moving a worktree may leave disposable old runtime state, not a
  renamed Session or branch identity.
- **The gap:** Shared repository identity did not define which operational
  resources should be shared and which should be isolated.
- **The reach:** Linked worktrees have one capture history without one global
  portable-writer bottleneck.
- **Verdict:** Sound. Each lock and key follows the resource it actually owns.
- **Confidence:** High.

### Allocate sequence numbers only for genuinely new event identities

- **When:** Journal identity and sequence design.
- **The choice:** A provider retries an event because it lost Factory's reply.
  Factory combines local journal scope, provider, native Session, generation,
  and event ID into one identity. Matching bytes return the original row;
  conflicting reuse is corruption. Only a new identity advances the explicit
  sequence counter in the same transaction. Ignored duplicate inserts cannot
  consume numbers and leave phantom events in the logical order.
- **The gap:** Idempotence and contiguous ordering were required without an
  allocation mechanism or complete identity tuple.
- **The reach:** Concurrent hooks and retries share one reproducible order;
  recreating runtime state starts a new local scope rather than reusing old
  operational identity. This is repository-global order, not a consecutive
  counter inside each Session: if A occupies positions 10 and 12 and B occupies
  11, A's portable Turn retains 10 and 12. The frozen claim proves A's exact
  membership; its range endpoints do not claim ownership of B's position.
- **Verdict:** Sound. Event insertion and sequence allocation are one durable
  decision.
- **Confidence:** High.

### Freeze each Stop claim permanently and complete it only with portable proof

- **When:** Journal claim and recovery state machine.
- **The choice:** Claiming a Stop freezes its exact event identities and cutoff.
  Only the creating transaction receives execution authority; another caller
  observes the existing claim. After a crash, recovery resumes that same
  frozen input instead of expiring or replacing it. Completion requires exact
  immutable Turn bytes verified by the repository store, then checked by the
  journal. A plausible path and hash alone cannot retire pending capture.
- **The gap:** Claims were named without lease/fencing semantics or a proof
  requirement at completion.
- **The reach:** Events arriving after the cutoff belong to later work; neither
  time nor apparent process death can silently alter already claimed evidence.
  Capture and later review readers require strictly increasing event positions,
  matching range endpoints, and the exact ordered raw-object inventory. They
  do not interpret positions belonging to another Session as lost evidence.
- **Verdict:** Sound. Permanent input plus immutable completion removes unsafe
  ownership guesses.
- **Confidence:** High.

### Keep private capture paths and diagnostic interpretation with the journal

- **When:** Runtime-path and diagnostic ownership design.
- **The choice:** Production opens the journal from a Git worktree, which the
  journal resolves to private Git-common storage with restrictive permissions
  and no symbolic links on owned entries. The CLI cannot choose an arbitrary
  production journal directory or read SQLite tables to implement Doctor.
  Instead, the journal supplies a typed bounded inspection. Inspection does
  not create an absent database and distinguishes half-present corruption from
  an empty journal.
- **The gap:** Callers needed storage and diagnostics without becoming parallel
  filesystem/schema authorities.
- **The reach:** Private layout can change behind one owner; portable IDs never
  choose machine-local journal paths.
- **Verdict:** Sound. Capture durability and its interpretation stay together.
- **Confidence:** High.

### Let hook failures be visible without blocking the coding Session

- **When:** Hook-facing failure design.
- **The choice:** Durable append has a real error, such as a full disk. The
  strict storage API reports it; the provider adapter still returns the
  nonblocking hook response. Factory attempts a private,
  content-addressed diagnostic but does not throw again if diagnostic storage
  also fails. Repeated identical failures converge and diagnostic inventories
  are bounded. Raw bytes that reached the journal remain recoverable.
- **The gap:** Visible storage failure and a continuing coding Session needed
  separate API responsibilities.
- **The reach:** Provider response vocabulary stays in the adapter; journal
  errors do not become a second provider protocol or leak transient logs into
  committed evidence.
- **Verdict:** Sound. Failure to preserve evidence is not hidden as successful
  storage, yet does not strand the user's coding work.
- **Confidence:** High.

### Finish observation before publishing its evidence

- **When:** Git observation design.
- **The choice:** Factory reads bounded code bytes, checks the ending repository
  state for a race, and only then publishes the snapshot objects and manifest.
  If the developer changed a file during capture, the observation says so.
  Publishing `.factory` objects during the read window would make Factory's own
  output participate in its race check and confuse bookkeeping with a source
  change.
- **The gap:** Read-only observation and sole-writer publication were separate
  interfaces without an explicit ordering boundary.
- **The reach:** Later capture callers must preserve bounded observation first,
  publication second; partiality describes the source, not Factory's writes.
- **Verdict:** Sound. The sentinel measures the state it claims to measure.
- **Confidence:** High.

### Compare exact code bytes without asking Git to inspect live content

- **When:** Hostile-filter observation review.
- **The choice:** A repository attaches a clean filter to a source file. Factory
  reads that file's bytes itself and compares identities and modes with parsed
  index and HEAD data. It does not call status/diff-shaped live-content
  inspection that can execute the configured filter, even when external diff
  and text conversion appear disabled. Review planning derives the change from
  those exact snapshots instead of depending on a convenient generated patch.
- **The gap:** Optional patch output conflicted with the observer's no-filter
  execution boundary.
- **The reach:** A future patch generator must prove the same boundary rather
  than assuming a read-looking Git command is inert.
- **Verdict:** Sound. Exact evidence is retained without running repository
  programs as a side effect of observation.
- **Confidence:** High.

### Keep Factory evidence out of recursive code snapshots

- **When:** Workspace namespace inclusion design.
- **The choice:** A review records new files under `.factory`; the next code
  snapshot excludes that entire namespace, including unknown contents and
  `.factory/skills`. Selected skills and Factory evidence enter the bundle
  through explicit inputs instead. The alternative would make each review
  recursively capture prior reviews as application source and grow through its
  own output.
- **The gap:** Preserving unknown Factory contents did not say whether those
  contents were also code-snapshot inputs.
- **The reach:** Being preserved in Git is not the same as being selected for
  model visibility; review inputs remain separately inventoryable.
- **Verdict:** Sound. One namespace has one role and does not feed itself.
- **Confidence:** High.

### Preserve link evidence without reconstructing unsafe authority

- **When:** Code reconstruction design.
- **The choice:** A captured symbolic link points outside the reconstruction or
  a pair of links forms a cycle. Factory preserves the raw target bytes as
  evidence, but preflights the entire link graph and refuses that filesystem
  reconstruction before writing entries. If reconstruction fails later, its
  caller discards the whole disposable destination; Factory does not selectively
  unlink paths that another process could have replaced between check and
  deletion. Readable raw objects can still inform a partial review.
- **The gap:** Lossless links did not specify which links a reviewer may follow,
  nor how failed destinations could be safely cleaned.
- **The reach:** Evidence fidelity never authorizes access outside a verified
  bundle, and failed output never becomes a usable snapshot.
- **Verdict:** Sound. Raw facts and reconstructed filesystem authority are
  deliberately different.
- **Confidence:** High.

### Read native directory outcomes from the call result, not shared error state

- **When:** Native directory boundary, `046b478`.
- **The choice:** Factory inventories a reconstructed directory through its
  already bound file descriptor. A native read reports bytes, end-of-directory,
  or failure in its return value. It does not return to JavaScript and then
  inspect libc's thread-local `errno`, an error slot unrelated runtime work can
  change before Factory reads it. Bounded native batches retain raw filename
  bytes and validate entry lengths before interpreting them. The alternative
  could misclassify successful end-of-directory as an error—or lose an error—
  because the result depended on a separate mutable side channel.
- **The gap:** Descriptor confinement did not define how native success and
  failure cross the runtime boundary without relying on ambient error state.
- **The reach:** The supported platform directory layouts remain an explicit
  native dependency, but no C-compiler requirement is added. Inventory ownership
  and byte-preserving names remain unchanged.
- **Verdict:** Sound. One return value carries the operation's own outcome
  instead of consulting state that can already describe another operation.
- **Confidence:** High.

### Make the trigger the logical commit point of a Turn

- **When:** Capture publication and recovery design.
- **The choice:** A Stop publishes objects and immutable Turn records first,
  then its review trigger last. A crash halfway through can leave physical
  files, but readers expose only the complete trigger-linked graph. Recovery
  converges the same deterministic bytes and limitations before completing the
  journal claim. It does not accept a merely schema-valid replacement or delete
  unmatched files to hide a conflict.
- **The gap:** A filesystem cannot atomically publish a graph across several
  existing directories using one rename.
- **The reach:** No partial public Session means no partially committed graph
  in projections, not a promise that interrupted disks contain no orphan files.
- **Verdict:** Sound. A visible commit point makes multi-file durability
  explicit and rebuildable.
- **Confidence:** High.

### Keep raw provider payloads canonical without duplicating them in envelopes

- **When:** Turn record-size design.
- **The choice:** A large hook payload appears once as exact bytes in the
  content-addressed store. The Turn's event inventory names that object and its
  observation order; it does not embed a second parsed JSON copy. An analyzer
  needing a field parses the selected bounded raw object. Otherwise many large
  hooks could make the structured inventory itself impossible to read within
  the public record limits.
- **The gap:** Lossless storage did not require or prohibit parsed convenience
  payloads in the envelope.
- **The reach:** No parsed projection outranks provider bytes, and duplication
  cannot inflate every downstream structured record.
- **Verdict:** Sound. One canonical copy preserves both fidelity and bounds.
- **Confidence:** High.

### Route evidence to the exact linked worktree that produced it

- **When:** Linked-worktree capture recovery.
- **The choice:** A Session begins in one initialized checkout and later stops
  in a linked worktree. Its first repository identity remains the owner, but
  that Stop's evidence is published beside the code in the recorded producing
  worktree only after Git-common membership and portable repository ID match.
  A branch that predates `.factory` stays pending rather than publishing its
  source snapshot into a different branch. Completion freezes the destination
  so recovery checks the same records.
- **The gap:** Shared Git metadata alone did not prove where portable evidence
  belonged when linked branches had different Factory initialization state.
- **The reach:** Recovery can operate from a matching checkout without searching
  unrelated repositories or inventing branch ownership.
- **Verdict:** Sound. Operational routing remains exact while Session ownership
  stays singular.
- **Confidence:** High.

### Remove only exactly recorded Factory hooks

- **When:** Hook reconciliation and inspection.
- **The choice:** Factory records fingerprints of the exact provider-native
  hook groups it installed. Uninstall removes only those exact entries. A user
  editing an entry makes it foreign; a similar-looking command is not removal
  authority. Inspection uses the same adapter-owned semantics to distinguish
  exact, duplicated, stale, and edited candidates without claiming the edited
  ones. No custom ownership field is injected into provider schemas.
- **The gap:** Hook ownership needed proof without extending provider formats
  or guessing from command text.
- **The reach:** Diagnostics can become richer without widening deletion
  authority; future reconciliation must preserve unknown provider content.
- **Verdict:** Sound. The ownership proof is narrower than visual similarity.
- **Confidence:** High.

### Use one installation transaction for hooks, repair, and executable replacement

- **When:** Installation ownership and upgrade cutover.
- **The choice:** Install, uninstall, repair, and upgrade share one global
  OS-released lock and a strict tagged recovery record. Hook reconciliation and
  executable replacement are different operation kinds under that owner, not
  parallel journals. Configuration reads are bounded and reject symbolic-link
  final components; inspection reports statuses, not provider bytes. Unknown
  operations fail before mutation. The abandoned unlaunched journal format has
  no compatibility reader.
- **The gap:** Hook-only recovery would otherwise expand into independent
  installation and upgrade authorities.
- **The reach:** Interrupted operations retain exact before/after proofs, while
  every installation mutation has one place to recover and inspect it.
- **Verdict:** Sound. One transaction hierarchy replaces accumulated wrappers.
- **Confidence:** High.

### Group GitHub history by provider identity rather than repository spelling

- **When:** PR identity design.
- **The choice:** GitHub renames `owner/widget` to `company/widget`. Factory's
  repository key remains based on GitHub hostname and stable repository node
  ID, while each observation retains its then-current name and URL. A fork or
  another GitHub installation gets a distinct identity. If `gh` fails before
  revealing identity, the result remains a typed runtime unavailability—not
  portable evidence under a name-derived key that only looks stable.
- **The gap:** Rename/fork support needed a stable, path-safe grouping rule.
- **The reach:** PR history survives renamed locators without conflating forks
  or minting identity from failed discovery.
- **Verdict:** Sound. The provider owns identity; names remain observations.
- **Confidence:** High.

### Preserve coherent partial PR evidence without inferring missing membership

- **When:** Bounded GitHub observation.
- **The choice:** Factory reads bounded metadata and commit pages, the exact
  patch, then repeats the metadata/commit observation. Matching views can
  retain the readable patch even when commit membership is only a bounded
  prefix or fork details are absent. A partial list proves its observed
  entries, never that an unlisted commit is absent. Mutation or an incoherent
  patch produces unavailability instead of a stitched-together PR state.
- **The gap:** Best-effort review did not define consistency across multiple
  provider calls or the meaning of a capped commit list.
- **The reach:** Large or deleted-fork PRs remain useful without granting
  partial metadata complete-set authority.
- **Verdict:** Sound. Readability and completeness are separate typed facts.
- **Confidence:** High.

### Distinguish exact Session/PR evidence from human inclusion

- **When:** Association fold and manual inclusion command.
- **The choice:** A verified Turn observed a commit exactly equal to the PR
  head or a member of its complete commit set. That can associate the Session,
  including exact fork evidence; branch names, paths, and nearby times cannot.
  A human can instead use `factory associate` with an existing Session, actor,
  and reason. That record is explicitly asserted, never relabeled verified.
  A later complete observation can invalidate old machine proof while retaining
  the original record; partial membership cannot prove such absence.
- **The gap:** Exact fork evidence and manual intent needed distinct authority,
  and the persistence seam alone did not provide a user action.
- **The reach:** Direct many-to-many Session/PR association needs neither Epics
  nor heuristic branch identity. Manual inclusion stays a consequential command.
- **Verdict:** Sound. Machine proof, human assertion, and invalidation remain
  distinguishable in portable history.
- **Confidence:** High.

### Commit association derivations through immutable completion batches

- **When:** Association crash consistency.
- **The choice:** A PR observation produces several association records. They
  remain physical prefixes until a final immutable batch names their hashes,
  sources, policy, and action time. Readers validate that group and ignore
  incomplete prefixes. Manual assertions retain their original action times
  when carried to later exact PR observations, rather than masquerading as new
  human decisions each time.
- **The gap:** Individually immutable association files did not make a
  multi-record derivation logically atomic.
- **The reach:** Recovery converges without deleting history, while orphan
  files cannot silently become review-selection authority.
- **Verdict:** Sound. The same explicit commit-point principle applies to
  derived association graphs.
- **Confidence:** High.

### Freeze review records but load object bytes only by validated reference

- **When:** Review input loading.
- **The choice:** A repository contains years of captured objects. Planning
  freezes the bounded review-owned record inventory through confined
  filesystem descriptors, verifies the inventory did not change, and opens
  object bytes only when a validated record names their hash and length. It
  does not scan every historical object or reopen mutable paths midway through
  execution. The tradeoff is an in-memory record snapshot, not a copy of the
  entire object store.
  An absent owned record directory can mean no records; an ordinary file or
  other malformed object where that directory belongs is an integrity failure,
  not empty history. Verification reports the same malformed root rather than
  preserving it as unknown foreign content. This distinction applies to names
  Factory owns, not arbitrary files it has promised to leave alone.
- **The gap:** Immutable bounded inputs did not choose between whole-store
  copying, held descriptors, or reference-driven loading.
- **The reach:** Expensive evidence work follows selected references, while a
  future streaming reader must preserve the frozen-input property.
- **Verdict:** Sound. Complete record discovery does not require unrelated
  object traversal.
- **Confidence:** High.

### Prove historical limitations without importing historical source by accident

- **When:** Portable history and bundle verification.
- **The choice:** An earlier partial review says an optional object was missing
  from its code manifest. A current review includes the exact old manifest
  needed to verify that claim, but does not recursively expose the old source
  tree to the new reviewer. The validation root is selected proof, not a
  blanket instruction to traverse everything it references.
- **The gap:** Offline provenance validation and minimal model visibility could
  otherwise conflict through generic recursive object loading.
- **The reach:** Old limitations remain independently verifiable; adding old
  source as context requires a separate explicit selection decision.
- **Verdict:** Sound. Validation authority and model visibility are separate.
- **Confidence:** High.

### Serialize the whole current-subject review and sample policy after waiting

- **When:** Concurrent review design and global preference correction.
- **The choice:** Review A runs while B waits for the same workspace or exact
  PR. B acquires the subject lock only after A publishes, then reads current
  repository/global configuration, observes current code, and replans against
  the new history. Repository preferences override global preferences, which
  override built-ins through one fold. Explicit command arguments stay fixed.
  Locking only the bundle would miss duplicates because fresh observations
  deliberately have new IDs.
- **The gap:** Convergence did not define the lock scope or whether queued
  commands froze mutable settings at invocation.
- **The reach:** A queued command means review when its turn arrives, not a
  pre-snapshotted job. Different PR subjects remain independent.
- **Verdict:** Sound. Policy, current evidence, and prior accepted work are
  sampled under the same operation authority.
- **Confidence:** High.

### Give each reviewer attempt one recoverable private identity

- **When:** Execution and acceptance recovery.
- **The choice:** A verified bundle, reviewer settings, image, and policy identify
  one logical attempt in Git-common runtime storage. Before Docker starts,
  Factory records its review ID and exact labeled container ownership.
  Concurrent callers converge there; recovery removes only that proven
  container. After immutable acceptance, the transient attempt is removed and
  portable review history becomes the no-rerun authority. Empty stable lock
  files remain outside disposable attempts as described above; they retain no
  provider response and do not accumulate into an active-attempt execution cap.
- **The gap:** Retry convergence and container cleanup needed a durable
  single-flight identity without putting machine state into Git.
- **The reach:** Linked worktrees can recover a shared attempt, while a stale
  waiter must reload accepted history rather than rerun a finished model.
- **Verdict:** Sound. Recoverable execution state is distinct from portable
  review truth.
- **Confidence:** High.

### Accept partial coverage without making Docker recovery a prerequisite

- **When:** Partial acceptance design.
- **The choice:** A valid partial review already exists in Git, but this
  machine has a broken temporary reviewer directory. The user can accept that
  exact partial review without opening Docker coordination. Acceptance reuses
  one deterministic action identity derived from the review ID, so concurrent
  retries converge rather than appending duplicate acknowledgements. A later
  actual reviewer execution still performs mandatory runtime cleanup.
- **The gap:** Explicit coverage acceptance did not need the same transient
  prerequisites as model execution, and retry identity was unspecified.
- **The reach:** Portable progress survives broken machine-local state. V1
  whole-review acceptance has one action; accepting selected gaps later needs
  a new explicit identity contract.
- **Verdict:** Sound. Acknowledging committed evidence and executing a model
  have different authorities.
- **Confidence:** High.

### Treat the exact stored review group as authority, not an ID alone

- **When:** Stored-history hardening.
- **The choice:** Two subject roots contain the same review ID. Factory does
  not display the first ledger found or accept coverage by borrowing its
  response. It loads each exact manifest/response/ledger group with subject
  lineage; an ID-only operation is ambiguous and fails. One pass indexes those
  groups rather than rescanning all records for every review.
- **The gap:** IDs were syntactically valid without a global uniqueness promise
  across every possible subject root.
- **The reach:** Display, enforcement, retry recovery, and partial acceptance
  share one grouping rule and avoid quadratic history loading.
- **Verdict:** Sound. Immutable group membership supplies the authority every
  consumer actually needs.
- **Confidence:** High.

### Keep subject acquisition upstream of pure planning and acceptance

- **When:** Review ownership consolidation.
- **The choice:** Workspace acquisition records a fresh Git observation; PR
  acquisition records fresh GitHub evidence and verified associations. The
  planning owner turns those facts into a frozen plan. At the other end,
  acceptance validates output and publishes history without reaching back into
  live Git or GitHub. The CLI sequences these owners instead of inventing a
  second review workflow in capture or reconstructing repository paths itself.
- **The gap:** The plan named input and output seams without placing the live
  acquisition step in one package.
- **The reach:** New subjects have one upstream entry; accepted results depend
  on frozen inputs rather than whatever the checkout says later.
- **Verdict:** Sound. Data flows in one direction across clear authorities.
- **Confidence:** High.

### Wake background review without creating a daemon or a second queue

- **When:** Automatic dispatch, `3b4de63`.
- **The choice:** With automatic review enabled, capture first materializes the
  durable Stop, then relaunches the installed Factory executable detached from
  hook input/output. A SessionStart can recover a missed wake. One non-waiting
  worker lock per worktree coalesces overlapping wakes; the existing subject
  lock still protects model execution. A worker drains new durable triggers,
  then rereads after releasing ownership so a wake arriving during shutdown is
  not lost. Hooks wait for process spawning, never model completion.

  ```text
  publish durable Stop -> wake installed Factory
  if another worker owns this worktree: exit the extra wake
  drain newly pending triggers under existing review rules
  release worker ownership -> recheck for a late new trigger
  ```

- **The gap:** A stored automatic-review preference did not define dispatch,
  overlap, or shutdown behavior.
- **The reach:** Existing portable triggers remain the queue; private locks and
  suppression memory are not a daemon, branch identity, or coverage authority.
- **Verdict:** Sound. Scheduling reuses durable work and established execution
  boundaries without accumulating waiting hook processes.
- **Confidence:** High.

### Reuse only the selected provider's existing login

- **When:** Authentication boundary and zero-setup completion.
- **The choice:** A user already logged into Codex or Claude asks for review.
  Factory discovers the provider-owned login instead of requiring a Factory
  account or second token setup. Ordinary auth files remain identity-checked,
  read-only mounts. On macOS, Claude's login is in Keychain: Factory extracts
  only its `claudeAiOauth` inference identity into a private `0600` attempt
  file, mounts it read-only, and removes it through normal or crash cleanup.
  Unrelated Keychain values such as MCP OAuth credentials do not cross.
- **The gap:** File-only handoff could not use a normally authenticated macOS
  Claude installation.
- **The reach:** No full provider home is copied, file permissions are not
  loosened, and token environment variables are not borrowed. Factory does not
  copy discovered authentication material into portable evidence, images, or
  logs. This is not redaction: secrets already present in raw captured
  conversations remain part of that plaintext evidence. Explicit paths remain controlled
  overrides for nonstandard installations and tests.
- **Verdict:** Sound. Provider-owned login reuse implements the user's
  zero-setup requirement with minimum selected credential authority.
- **Confidence:** High.

### Authorize the frozen bundle and the mounts Docker actually receives

- **When:** Reviewer isolation and bundle hardening.
- **The choice:** Only verification of a ready plan mints execution authority.
  Factory copies that verified bundle into private runtime storage, verifies
  the copy, resolves bind sources to canonical filesystem identities, and
  rejects path overlap or Docker option-grammar ambiguity. It creates the
  container stopped, inspects observed sources/targets/modes, and starts it
  only if they match policy. The runner verifies the read-only input again
  before provider startup. A path-shaped object or requested argv is not proof.
- **The gap:** Immutable bundles and allowlisted mounts needed an actual
  enforcement sequence across host and container boundaries.
- **The reach:** Symlink spelling or a writable intermediate copy cannot widen
  model access. Cleanup owns only the private snapshot, never the live checkout.
- **Verdict:** Sound. Execution authority is verified against actual resources
  before the provider receives them.
- **Confidence:** High.

### Make Docker the filesystem boundary and kill the entire review sandbox

- **When:** Isolation design and authenticated provider integration.
- **The choice:** The selected CLI runs as a validated unprivileged numeric
  identity with dropped capabilities, read-only image and evidence, bounded
  `/tmp`, and a separate empty bounded provider-home tmpfs. Its credential is
  a nested read-only mount; only the response directory is writable host
  output. Codex's inner user-namespace sandbox is disabled because confinement
  is supplied by the observed Docker policy. On timeout or cancellation,
  Factory forcibly removes the named container, not just the local process
  waiting for it, so provider descendants cannot remain running.
- **The gap:** The plan fixed isolation properties but not provider scratch
  behavior or whole-process-tree cancellation mechanics.
- **The reach:** No live checkout, Docker socket, or unrelated provider home is
  available. Provider scratch is ephemeral, not a writable host config.
- **Verdict:** Sound. Authority and cleanup follow the whole sandbox rather
  than one client process or a redundant nested sandbox.
- **Confidence:** High.

### Publish a shared reviewer image but execute only immutable identity

- **When:** Production image publication.
- **The choice:** One published image contains both pinned provider clients and
  supports the container architectures required by the host targets. Tags make
  it discoverable, but Factory selects a complete digest-qualified reference,
  verifies Docker observed that digest, and records it in the attempt. Moving
  a tag cannot change an already chosen environment. Controlled local fixtures
  use verified immutable image identity too, not a fake production claim.
- **The gap:** Isolation fixtures did not supply a production distribution
  channel, and mutable publication names did not provide reproducible execution.
- **The reach:** A channel can change without changing the immutable attempt
  model or introducing provider-specific container concepts.
- **Verdict:** Sound. Publication location and executable identity are separate.
- **Confidence:** High.

### Accept one bounded semantic response, not an arbitrary artifact tree

- **When:** Reviewer output design.
- **The choice:** A reviewer writes its structured review response through one
  size-limited surface. A readable valid prefix may become partial evidence;
  foreign output fails closed and operational diagnostics remain private.
  Factory does not accept arbitrary files merely because the model placed them
  in its writable output directory. The alternative would turn review output
  into general storage or accidentally commit debug logs as evidence.
- **The gap:** The plan bounded semantic output without choosing a general
  artifact API.
- **The reach:** Future reviewer-generated artifacts require an explicit typed,
  bounded format rather than a relaxed output-tree policy.
- **Verdict:** Sound. Portable output has one inspectable semantic contract.
- **Confidence:** High.

### Group decisions by explicit keys and structured material assertions

- **When:** Decision model implementation.
- **The choice:** Two reviewers describe the same database policy with
  different wording. Factory groups them by the explicit stable decision key
  supplied by the reviewer. The prompt requires evidence of continuity before
  reusing a key; the deterministic fold does not independently prove semantic
  continuity from prose. Material
  equality compares the structured assertion and assert/remove/contradict
  effect, not summary phrasing or confidence. An omitted decision does not mean
  it was removed. Without a justified key link, observations remain separate.
- **The gap:** An opaque summary could not distinguish replay, change, removal,
  and contradiction without fuzzy inference.
- **The reach:** Review prompts must preserve proven keys; Factory cannot
  silently merge intent from similar prose.
- **Verdict:** Sound. Material identity is explicit, deterministic, and separate
  from presentation or analyzer confidence.
- **Confidence:** High.

### Derive canonical scope from exact configured-branch evidence, not approval

- **When:** Canonical decision fold.
- **The choice:** A workspace observation is exact and says its branch is the
  committed `canonicalBranch`; its decisions enter canonical scope. A PR or
  other workspace produces proposals. Canonical scope still does not confirm
  an observation on the human's behalf. A later GitHub default change produces
  a diagnostic, not a silent reclassification driven by remote state.
- **The gap:** A stored canonical boolean and a separate config argument would
  create competing authorities.
- **The reach:** Configured policy governs classification; exact canonical
  changes can be high priority without claiming human approval.
- **Verdict:** Sound. Observation, scope, and confirmation remain independent.
- **Confidence:** High.

### Make human actions exact, directional, and stale-safe

- **When:** Append-only decision action design.
- **The choice:** Confirm/reject/dispute names one observation; resolve names
  its active dispute; supersede names old and replacement observations. Each
  request includes the exact history fingerprint and action head the user saw.
  The sole writer compares current authority under its mutation lock before
  append. Retries converge with the first successful timestamp; concurrent
  children after a Git merge cannot both advance the accepted head. An action
  never silently propagates to another observation merely because it repeats
  the same assertion.
- **The gap:** Undirected target arrays and similarity-based status propagation
  could not encode exactly what the human authorized or close stale-write races.
- **The reach:** Full action history—including a dispute later resolved—affects
  staleness. Invalid merged actions remain visible diagnostics, not rewrites.
- **Verdict:** Sound. Durable action scope matches its actual effect and the
  writer checks the complete authority it extends.
- **Confidence:** High.

### Admit decision observations only when accepted review evidence reproduces them

- **When:** Stored decision verification.
- **The choice:** A standalone observation file claims a canonical change.
  Factory admits it only if its exact bytes reproduce from an accepted review
  decision entry and exact subject record. Recovery recreates missing derived
  files through create-only publication and rejects unequal bytes at an
  existing identity. The observation file is a rebuildable projection, not an
  independent source of truth just because its JSON passes schema validation.
- **The gap:** Schema-valid orphans could otherwise manufacture decision
  authority without any accepted analysis behind them.
- **The reach:** Clones and recovery can rebuild projections from raw review
  evidence; conflicts stay inspectable instead of being silently overwritten.
- **Verdict:** Sound. Derived records cannot outrank their verified source.
- **Confidence:** High.

### Keep impossible first transitions diagnostic rather than actionable

- **When:** Canonical transition review.
- **The choice:** The first observed canonical entry says remove or contradict,
  but there is no predecessor to replace. Factory reports high-priority invalid
  evidence rather than presenting a pending supersession that the action
  schema cannot complete. A valid supersede action needs both old and
  replacement observations; inventing an old decision would hide missing
  evidence.
- **The gap:** Initial transition handling could create a pending state with no
  legal terminal action.
- **The reach:** The interface promises only actions the durable model can
  actually express; malformed evidence remains visible.
- **Verdict:** Sound. Pending work must have a representable completion path.
- **Confidence:** High.

### Share historical folds instead of teaching each interface its own truth

- **When:** Domain projection consolidation.
- **The choice:** The browser says a trigger is covered using the same validated
  history fold that excludes it from the next incremental plan. Association
  batches, exact review groups, coverage actions, and decision history are
  interpreted by one domain owner. The UI gets a compact projection and the
  exact unresolved dispute ID needed for its action, not a pile of raw records
  to reinterpret. Invalid or ambiguous history fails safe.
- **The gap:** Separate planning and presentation folds could disagree about
  coverage, partial acceptance, or stale actions.
- **The reach:** New consumers reuse the historical meaning rather than
  inventing optimistic local shortcuts.
- **Verdict:** Sound. Presentation is derived from the same authority as action
  and review behavior.
- **Confidence:** High.

### Keep the browser short-lived and expose only typed human intents

- **When:** Local interface and HTTP action design.
- **The choice:** `factory open` serves compiled assets on `127.0.0.1` for the
  command's lifetime. It adds no daemon, account, or hosted dependency. Browser
  actions use schema-checked decision and exact partial-coverage intents with
  same-origin/CSRF checks, then delegate semantic compare-and-append to existing
  owners. The browser cannot submit arbitrary `.factory` paths or generic
  mutations, and an unavailable repository has no action authority.
- **The gap:** A presentation technology and action seam were needed without a
  second durable store or repository writer.
- **The reach:** A richer client can replace the dependency-light browser code
  only while preserving the narrow local server contract.
- **Verdict:** Sound. The interface expresses intent rather than gaining
  general filesystem authority.
- **Confidence:** High.

### Observe GitHub drift only for display, without changing canonical policy

- **When:** Diagnostic ownership and UI correction `5bfdfe0`.
- **The choice:** GitHub changes its default from `main` to `trunk` while
  Factory's configured canonical branch stays `main`. Opening or refreshing
  the UI asks the GitHub adapter for a bounded observation and shows the same
  disagreement policy as Doctor. Display discovery has a short 750 ms budget;
  missing or offline GitHub cannot invent drift. Submitting a decision action
  validates local evidence without waiting for GitHub. The warning does not
  change config or reclassify decisions automatically.
- **The gap:** A Doctor-only warning missed the primary UI, while reusing live
  discovery for every snapshot would delay local actions.
- **The reach:** Remote default observations are advisory; configured canonical
  policy remains authoritative until the user changes it.
- **Verdict:** Sound. Useful current information does not acquire mutation or
  action-path authority.
- **Confidence:** High.

### Build diagnostics from typed owner observations rather than ad-hoc probes

- **When:** Doctor ownership consolidation.
- **The choice:** Doctor asks the reviewer about Docker/login readiness, capture
  about bounded provider-version observations and hook semantics, repository
  verification about owned portable bytes, and the journal about pending work
  and private diagnostics. A pure policy fold assigns severity. It never
  reads credentials for display, duplicates a journal table query, or counts
  preserved foreign `.factory` paths as storage Factory owns.
- **The gap:** Useful aggregate diagnostics risked becoming parallel semantic,
  filesystem, and subprocess authorities.
- **The reach:** Missing providers, broken hooks, corrupt state, and remote
  unavailability remain independent facts; one missing prerequisite need not
  prevent inspection of another.
- **Verdict:** Sound. Observation belongs with its owner and policy only combines
  typed facts.
- **Confidence:** High.

### Separate deterministic visual fixtures from real repository journeys

- **When:** Browser and cross-boundary verification design.
- **The choice:** A compact fixture can render a disputed decision repeatedly
  at stable desktop/mobile framing. A separate real repository journey must
  prove that stored records project into that state and that HTTP actions append
  only authorized files. Neither substitutes for the other: screenshots alone
  do not prove storage semantics, while a storage fixture alone does not prove
  readable presentation. Human-readable reports expose actual authority and
  limitations rather than emphasizing green fixture results over missing proof.
- **The gap:** Building every visual state from a full repository would couple
  presentation tests to storage mechanics; hand-built screens could also mask a
  broken production projection.
- **The reach:** Visual and semantic failures remain separately reproducible.
  Durable promoted reports belong beside the spec; scratch output stays temporary.
- **Verdict:** Sound. Each layer proves its own boundary without overstating it.
- **Confidence:** High.

### Bind release bytes to one clean committed source tree

- **When:** Artifact identity design.
- **The choice:** A release build resolves its own repository, requires a clean
  tracked/untracked inventory, and refuses a requested revision different from
  HEAD. It embeds source revision, release version, target, and runtime identity
  while disabling ambient `.env` and Bun configuration autoloading. A caller
  cannot label dirty or unrelated bytes with a trusted commit string.
- **The gap:** User-supplied revision or working directory could claim source
  identity without proving what was compiled.
- **The reach:** Ordinary dirty development builds remain possible, but cannot
  mint release authority or certify later source changes retrospectively.
- **Verdict:** Sound. Artifact identity is derived from the actual build input.
- **Confidence:** High.

### Verify transport, executable identity, and provenance independently

- **When:** Release verifier and attestation design.
- **The choice:** A trusted manifest digest authenticates the manifest; that
  manifest pins the archive; its bounded exact inventory separately pins the
  executable and release identity. The package includes its license inventory
  and embedded runtime notices. A checksum fetched beside an untrusted binary
  proves consistency, not provenance, so GitHub attestation is a separate
  authority. Pull requests cannot mint repository release attestations.
- **The gap:** Release-shaped JSON and adjacent checksums alone did not prove
  source, byte identity, or redistribution obligations.
- **The reach:** Acquisition must provide trusted manifest authority before the
  verifier can grant executable replacement authority. Runtime updates move the
  notices and corresponding verification together.
- **Verdict:** Sound. No one evidence layer pretends to prove another.
- **Confidence:** High.

### Promote only a verifier-minted executable that has actually run

- **When:** Executable upgrade and recovery design.
- **The choice:** Verification mints an opaque release capability rather than
  accepting a structurally plausible object. Upgrade stages its immutable bytes
  beside the installed executable, checks digest and exact embedded version by
  running it, and records the verified stage before atomic replacement. A
  crash before that proof retains the old executable; recovery may promote
  only a verified stage. Changed installed or staged bytes cause refusal rather
  than overwrite. Promotion revalidates the paths and result.
- **The gap:** Correct-looking metadata or correctly hashed but unrunnable
  bytes could otherwise become recovery's replacement authority.
- **The reach:** Install mutation and recovery distinguish planned work from
  proven executable bytes without granting authority over diverged user data.
- **Verdict:** Sound. Every recoverable state preserves either the known old
  executable or the verified new one.
- **Confidence:** High.

### Certify exact packaged bytes through distinct deterministic and live authorities

- **When:** Exact-artifact certification and automatic-login integration.
- **The choice:** The harness verifies an archive through the public verifier,
  installs only its minted executable into a disposable home, and drives the
  journey through that exact path. Deterministic review stages use fixture
  credentials and an instrumented image. A separate authenticated stage uses
  automatically discovered provider-owned logins and the production image,
  forcing both Codex and Claude rather than trusting whichever auto-selection
  preferred. Missing real authority remains unavailable, not simulated success.
  The disposable home never becomes permission to copy a user's full provider
  configuration or persist tokens outside attempt cleanup.
  For incremental behavior, observing another complete result is not enough:
  the relevant claim is that new Stop evidence receives new coverage and prior
  accepted context, while a repeated unchanged review reuses its immutable
  result without crossing into provider execution. Certification distinguishes
  those behaviors rather than inferring them from a success disposition.
- **The gap:** Source journeys could miss packaging faults, while one provider
  or a fixture could be mistaken for complete authenticated execution.
- **The reach:** Evidence certifies only the bytes and authorities exercised.
  Credential-free CI and authorized real-provider certification share product
  boundaries without conflating their claims.
- **Verdict:** Sound. Packaging, deterministic behavior, and real model execution
  remain separate and inspectable proofs.
- **Confidence:** High.

### Verify the journal at its declared minimum runtime

- **When:** Runtime compatibility authority audit.
- **The choice:** The built runtime-journal package is exercised at the declared
  Node floor with its real SQLite binding, not merely a newer host Node or
  Bun's different binding. The smoke opens, appends, and closes the journal in
  a pinned, networkless environment with ephemeral writable runtime storage.
  Success on a newer interpreter cannot stand in for a minimum-version claim.
- **The gap:** Naming Node 22 support did not prove that the chosen minimum
  release exposed the required SQLite engine.
- **The reach:** Changing the journal engine or runtime floor requires updating
  this compatibility authority with the product claim.
- **Verdict:** Sound. Support is checked at its actual boundary.
- **Confidence:** High.

### Certify real capture callbacks separately from model-review execution

- **When:** Live-capture certification, `7b03f19`.
- **The choice:** A production reviewer CLI normally runs with settings that
  suppress ordinary coding-session persistence or hooks. Running a successful
  model review therefore does not prove that a coding Session actually calls
  Factory's installed hooks. The capture harness uses a test-only image derived
  from the pinned reviewer image, with provider shims that run the real clients
  against disposable installed hooks and writable ephemeral configuration.
  It still uses the production attempt coordinator and Docker executor for
  selected read-only authentication, Claude's attempt-scoped Keychain staging,
  observed container policy, and cleanup. An instrumented Factory executable
  forwards callback input and output and records witnesses, including the raw
  input hash, so certification can compare actual Stop bytes with stored Turn
  evidence. Its response is an oracle observation, never accepted as semantic
  review history.
- **The gap:** Real review execution and replayed hook fixtures each proved a
  different boundary, leaving actual client-to-hook delivery unproved. A new
  test launcher could also have accidentally invented separate credential
  extraction and cleanup authority.
- **The reach:** Provider callback behavior can be observed without weakening
  the production reviewer or modifying the user's live provider configuration.
  This is a built-source capture journey, separate from exact packaged release
  certification; neither silently certifies the other.
- **Verdict:** Sound. The harness adds the missing observation while reusing
  production security ownership and keeping its output out of review acceptance.
- **Confidence:** High.

### Use deliberate reader refusal as one narrow fail-open proof

- **When:** Live-capture certification, `7b03f19`.
- **The choice:** A real provider completes an initial read task, then resumes
  the same native Session to create a second distinct Stop and immutable Turn
  with readable transcript evidence. Before a third resume, the test raises
  the disposable repository's minimum reader version beyond Factory's version.
  Capture must refuse that repository without changing its portable bytes,
  return the adapter's empty successful hook response, and let the provider
  produce its terminal completion. The completion assertion reads terminal
  provider records, not an echoed prompt containing the expected text.

  ```text
  first task -> initial Session and Stop
  resume same Session -> distinct Stop and Turn with transcript evidence
  require newer reader -> resume -> capture refusal and unchanged repository
  provider terminal response -> continuation despite this capture refusal
  ```

- **The gap:** A claim that hooks fail open needed an actual provider-facing
  failure scenario, but deliberately causing arbitrary host/storage failures
  would create unrelated authority and reproducibility problems.
- **The reach:** This proves the selected reader-refusal path and observed
  callback/resume behavior, not every storage failure or provider event.
  Compaction, subagents, permission flows, optional events, and final transcript
  closure need their own observations; this journey does not infer them.
- **Verdict:** Sound. A deterministic fault supplies a real, bounded proof
  without turning one successful failure scenario into universal certification.
- **Confidence:** High.
