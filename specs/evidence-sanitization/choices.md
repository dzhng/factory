# Implementation choices

## Sound · high confidence — Frozen capture keeps its worktree authority

When: publication admission integration.

A developer can have two linked worktrees that share one private capture journal.
If evidence prepared for one checkout could be restored into the other, that
checkout's env discovery would not have authorized the resulting publication.
The journal therefore derives the canonical worktree from genuine prepared
content, refuses a graph mixing different checkouts, and retains that binding
with the frozen plan. Recovery uses the same worktree and bytes without looking
up secrets again. The CLI remains the sole owner of Session routing; the journal
does not infer a destination from hook events, which can span repositories and
linked worktrees. The repository writer enforces the frozen destination.

The spec required durable replay but did not prescribe how a shared journal binds
its destination. This choice affects linked-worktree recovery and completion, not
the portable schema or the user's Git workflow. It is sound because a private
recovery record must not grant broader publication authority than preparation did.

## Sound · high confidence — Configuration inspection includes the merged existing fields

When: slice 4 config/init closure.

A user enables automatic review after a previously ordinary extension value
becomes a known env secret. Updating only the new boolean would copy that secret
back into the committed configuration. The repository writer instead checks the
entire merged configuration, including unknown keys, arrays and nested extras,
while holding its existing mutation lock. It refuses the write and keeps the old
bytes intact; it does not silently replace a branch or model with a marker.

Gap: the contract required all configuration writes to be prepared but did not
place discovery relative to read/merge/lock. Reach: configuration updates pay
bounded discovery cost under the existing lock, so concurrent updates cannot
invalidate the checked merge. Verdict: sound because the bytes admitted are the
exact bytes published. Confidence: high. The shared sanitizer and its discovery
limits remain the policy owner; no second config secret catalogue is introduced.

## Sound

### Bound the whole prepared capture, not just each leaf

- **When:** durable capture pass.
- **Choice:** A capture may contain many individually readable objects. Factory
  refuses preparation if their combined bytes exceed 512 MiB or the frozen plan
  exceeds 16 MiB, instead of holding an unlimited graph in memory. Each leaf
  still obeys the existing 64 MiB ceiling. The private journal retains the
  original capture so this failure cannot become a raw publication fallback.
- **Gap:** The plan required bounded private preparation without specifying an
  aggregate allowance for source, hooks, transcripts and portable records.
- **Reach:** Very large captures can remain pending instead of exhausting the
  hook process. Future tuning must preserve a whole-operation bound, not only
  increase per-file limits.
- **Verdict:** sound; the operation needs a finite resource budget before it can
  promise to prepare the entire graph before publication.
- **Confidence:** medium.

### Prepared reviews retain their output graph, not a second copy of bundle authority

- **When:** review-publication pass.
- **Choice:** After a review finishes, its private attempt saves the safe manifest,
  submissions, ledger, and derived decision observations before publishing any of
  them. The existing verified bundle still owns the input records and object
  inventory; recovery reopens that exact digest instead of copying those lists
  into the attempt again. The freeze accepts only repository-issued record
  capabilities and binds their root and exact encoded bytes to the raw attempt.
  The prepared output is capped at 8 MiB, with a 20 MiB
  outer attempt-state cap including raw diagnostic streams and JSON encoding.
- **Gap:** The spec required durable preparation but did not select its precise
  storage shape or byte ceiling.
- **Reach:** Larger input bundles do not enlarge the receipt merely by repeating
  their authority lists. Exceptionally large output graphs fail before publication;
  increasing that ceiling requires a bounded acquisition probe.
- **Verdict:** sound; one existing attempt owns recovery without a second bundle
  inventory or an unbounded in-memory publication plan.
- **Confidence:** medium.

### Human action retries retain a private request receipt

- **When:** human-action publication pass.
- **Choice:** When a user submits a note containing a secret, the repository writer
  saves a private hash of that exact request alongside its admitted safe action
  semantics, bound to the actual repository root.
  A retry can then return the original safe action after env values change. A
  different request under the same action ID is refused; the already-prepared
  semantics are also a valid retry. Receipts stay in existing private repository
  runtime state so old exact retries do not need a historical secret dictionary.
- **Gap:** The spec required stable retries but the action owner previously had
  only the public atomic record, not a private request-to-preparation binding.
- **Reach:** This adds one bounded private receipt per prepared decision action.
  It contains no secret dictionary or raw note, and its request hash never enters
  portable records. Coverage actions need no prose receipt because their payload
  is typed authority plus unchanged Session locators.
- **Verdict:** sound; preparation extends the existing action lock owner and keeps
  compare-and-append authority unchanged.
- **Confidence:** high.

### Mark combined stdout and stderr instead of preserving a false split

- **When:** provider adapter pass.
- **Choice:** When a Claude hook reports both output streams, Factory joins their
  text, redacts and trims it as one tool result, and stores it with an explicit
  combined-output label. The second stream field is empty. Splitting the shortened
  result back at the original character offset would invent a boundary after
  redaction changed the lengths, and separate budgets could retain twice as much
  low-value output. Tool-call identity and error status remain in the envelope.
- **Gap:** The policy required one result budget but did not specify how to
  represent native stream fields after text reduction.
- **Reach:** Reviewers keep the combined context but cannot infer which stream
  originally contained a retained character. This is review evidence, not a
  byte-faithful terminal recording.
- **Verdict:** sound; the explicit label makes that information loss visible.
- **Confidence:** high.

### Bound the matcher's memory as well as filesystem input

- **When:** policy/discovery pass.
- **Choice:** If a repository supplies a huge env value or text containing too
  many separate secret matches, preparation reports a fixed resource-limit
  failure. A hook can still return normally, but cannot publish unprocessed
  evidence. Reading a bounded file alone does not bound the larger in-memory
  search structure built from it. Repeated adjacent matches collapse into one
  redaction instead of exhausting the allowance.
- **Gap:** The plan bounded discovery but did not specify the matcher's internal
  storage ceiling. The chosen ceilings are recorded in the contract, backed by
  an oversized-dictionary regression and a repetitive-input probe.
- **Reach:** Producers must handle this as unavailable preparation, not fall back
  to raw publication. This can reject unusual inputs rather than risk an out-of-
  memory hook process.
- **Verdict:** sound; a fixed explicit failure preserves the publication boundary.
- **Confidence:** medium.

### Treat invalid UTF-8 and NUL-bearing source as unsupported text

- **When:** source observation pass.
- **Choice:** A binary file can contain text-like fragments, but Factory does not
  try to redact those fragments and publish the surrounding opaque bytes. A file
  that cannot decode strictly as UTF-8, or contains a NUL character, is omitted
  with a fixed reason. Other UTF-8 source remains reviewable, without relying on
  filename extensions. Leading byte-order marks remain part of retained text.
- **Gap:** The plan required omission of unsupported binary source without naming
  a text-classification rule.
- **Reach:** Some unusual NUL-bearing text is omitted rather than transformed;
  binary formats are not promised redaction support. This is a bounded text
  policy, not a general file-type detector.
- **Verdict:** sound; it avoids copying opaque source payloads while retaining
  common source encodings.
- **Confidence:** medium.

### Supplement Docker with isolated native platform probes

- **When:** policy/discovery pass.
- **Choice:** A filesystem flag that behaves differently on macOS must be tested
  on macOS as well as in the Linux Docker suite. The native probe uses a disposable
  temporary directory and a bounded child process; it never touches provider
  homes, hooks, or `.factory`. Docker remains the normal filesystem test gate.
- **Gap:** The plan's pure-tests-only host wording could not prove the required
  Darwin behavior. AGENTS permits isolated tests that do not touch the named live
  boundaries; the handoff now describes this supplemental platform check.
- **Reach:** Platform-specific filesystem changes inherit real platform evidence,
  without granting tests access to the developer's provider configuration.
- **Verdict:** sound; it strengthens rather than substitutes verification.
- **Confidence:** high.

### Verify selected bytes again without treating excluded content as input

- **When:** policy/discovery pass.
- **Choice:** If one env file changes while a later directory is scanned, compare
  its final bytes with the already-read value before returning the secret context.
  File timestamps alone can miss a same-size overwrite. The second read uses
  bounded chunks, not another complete copy. A build directory excluded by policy
  may change its contents without failing discovery; its identity still must not
  be replaced while inspected.
- **Gap:** The plan required race detection but did not define whether unchanged
  metadata proves unchanged content, or whether excluded content churn matters.
- **Reach:** Discovery does one extra bounded read of included env files. It does
  not expand its secret dictionary into excluded trees or make their routine
  writes block capture.
- **Verdict:** sound; check the bytes that determine protection, not unrelated
  content that the policy intentionally excludes.
- **Confidence:** high.

### Redact overlapping values together and retain both env spellings

- **When:** policy/discovery pass.
- **Choice:** If one secret covers `abc` and another covers `bcde`, text `abcde`
  becomes one redaction marker. Replacing only the longer value would leave the
  first secret's `a` visible. Likewise an env value written using an escaped
  newline is matched both when copied verbatim and when decoded into a message.
- **Gap:** The plan required deterministic overlapping matching and decoded env
  values but did not specify these two representation details.
- **Reach:** The same secret is protected in copied file output and decoded JSON;
  overlapping matches cannot leak each other's edge fragments.
- **Verdict:** sound; it protects the union of known sensitive content without
  adding a general-purpose recursive decoding system.
- **Confidence:** high.

### Opaque JSON scalars do not inherit structural-ID exemptions

- **When:** policy/discovery pass.
- **Choice:** If a provider payload contains a numeric password, it can become
  a redaction marker just like a string password. Validated Factory record IDs
  and counters have separate schema authority; an arbitrary number in opaque
  provider data does not acquire that authority merely by being numeric.
- **Gap:** The plan described decoded JSON strings explicitly, but all-message
  protection also has to cover numeric credentials.
- **Reach:** Opaque provider JSON may change scalar types where a secret is
  removed. Provider metadata is classified before transformation; portable
  structural fields must use their validated producer contract.
- **Verdict:** sound; no free bypass for numeric secrets.
- **Confidence:** high.

### Optional PR source shares the acquisition preparation budget

- **When:** GitHub observation pass.
- **Choice:** When optional PR source capture prepares files beside GitHub
  metadata and patches, those safe bytes share the acquisition's existing
  byte ceiling. A callback cannot keep growing a private in-memory collection
  indefinitely. This can refuse a large source capture that previously returned
  only a reference to objects written elsewhere; it does not create an
  additional storage service or an unlimited second budget.
- **Gap:** The plan required a complete safe graph and bounded acquisition but
  did not choose a separate allowance for privately prepared source bytes.
- **Reach:** Optional source providers must share the caller's sanitizer and
  object collection. Any future allowance increase should come with a bounded
  acquisition probe rather than silently bypassing that collection.
- **Verdict:** sound; a single preparation ceiling keeps transient memory
  bounded, and preparation failures stop before any committable prefix.
- **Confidence:** medium.

## Installed boundary foundation

- **When:** Installed audit journey checkpoint.
- **The choice:** Copy bounded bytes instead of cloning read-only files. When
  the native Linux CLI prepares a reviewer snapshot on a Mac-shared Docker
  mount, Bun's file-copy operation can create a file whose permissions cannot
  subsequently be changed. The snapshot now uses the existing confined reader
  (which refuses symlinks and changed file identity), creates a new destination
  exclusively, and makes it read-only. The complete snapshot must still match
  the verified bundle digest before Docker receives it. A streaming copy would
  use less transient memory; this choice holds at most one bounded bundle file
  at a time and avoids another filesystem traversal owner.
- **The gap:** The plan required real installed execution but did not prescribe
  the byte-copy mechanism across shared host filesystems.
- **The reach:** Snapshot preparation uses the existing bundle size ceilings and
  confined reader. It does not weaken final verification or add a fallback that
  runs against the live bundle when copying fails.
- **Verdict:** sound; a real bind-mount failure is removed without changing the
  isolation contract or hiding that filesystem from the test.
- **Confidence:** medium.

- **When:** Installed audit journey checkpoint.
- **The choice:** Give only the outer test harness Docker control. The installed
  Linux CLI runs in a disposable outer container and launches a real sibling
  reviewer through the mounted Docker socket. Both see the same absolute scratch
  paths, so the daemon mounts the files the CLI actually prepared. The outer
  container receives the socket's observed numeric group; the reviewer still
  receives only its production allowlisted mounts, never the socket. Running a
  fake Docker command instead would not prove actual isolation or native startup.
- **The gap:** The installed Linux test needs to exercise a daemon on the host
  while keeping provider configuration and repository writes disposable.
- **The reach:** This socket permission belongs solely to a test harness. The
  report distinguishes synthetic model behavior from real Factory execution.
- **Verdict:** sound; the test grants the authority needed to exercise the real
  boundary without granting it to the component under isolation.
- **Confidence:** high.
