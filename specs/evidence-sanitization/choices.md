# Implementation choices

Review the resource ceilings, binary-text rule, and internal recovery interface
first: these are sound choices with medium confidence about the user's preferred
tradeoff. No unresolved user-only or unsound choices remain in this ledger.

## Sound — medium confidence

### Bound the complete preparation, not just each file

When: capture, PR acquisition, and review publication.

One Session can contain many readable files whose combined size exhausts the
hook process. Factory bounds individual content and the entire private write
plan before copying or publishing it. Capture admits 512 MiB of content and
16 MiB of plan metadata. Review output admits 8 MiB of encoded publication within
a 20 MiB private attempt that also contains diagnostics. Optional PR source
shares its acquisition budget, not an unlimited side collection.

The spec required bounded preparation but left these combined allowances open.
This is sound because all-or-nothing preparation requires bounded memory, but
unusually large work can remain unpublished. The private original remains
available for diagnosis. Future tuning must measure the complete operation;
raising a per-file limit alone cannot disable its aggregate bound.

### Bound the matcher as well as discovery

When: shared policy.

A small env file can generate a larger search structure, and repetitive text can
produce many matches. Factory limits dictionary states and distinct match spans
as well as input bytes. Adjacent and overlapping matches coalesce. Exceeding a
ceiling fails preparation rather than publishing partially matched text.

The plan did not specify internal matcher storage limits. This is sound because
bounding filesystem input alone does not prevent an out-of-memory hook. Unusual
inputs may remain pending; the policy contract owns the ceilings and fixed
failure meaning rather than allowing producers to fall back to raw evidence.

### Recognize source text by strict UTF-8 without NUL

When: source observation.

A file named notes.txt may contain opaque binary data. Factory omits source that
cannot decode as UTF-8 or contains NUL rather than redacting visible fragments
and copying the rest. Valid UTF-8 source is retained regardless of extension,
including its leading byte-order mark.

The spec required binary omission without selecting a classifier. This is sound
for review context, but unusual NUL-bearing text is deliberately unavailable.
Supporting a binary format later requires a readable, sanitizable representation,
not a filename exception to the text rule.

### Restore prepared authority through an internal friend interface

When: repository admission and durable replay.

The writer accepts handles issued by preparation, not arbitrary bytes with a
boolean saying “safe.” Each handle privately owns an independent copy and its
checkout identity. After a crash, the journal verifies its saved owner and exact
bytes, then uses an internal package interface to recreate those handles. A
lookalike object cannot enter the normal publication API.

The plan required replay without choosing this runtime interface. This is sound
because it prevents accidental raw publication without rediscovering old secrets.
The interface is deliberately available to trusted recovery owners; it is not
a sandbox against malicious code already executing in the repository. Moving it
into another package would add ownership without strengthening that boundary.

### Copy one bounded bundle file instead of cloning readonly files

When: installed reviewer execution.

On a Mac-shared Docker filesystem, Bun's copy operation can create a destination
whose permissions cannot subsequently be changed when the source was readonly.
Factory instead reads one bounded file through its existing confined reader,
creates the destination exclusively, and makes it readonly. The entire snapshot
must still match the original verified bundle digest before review.

The plan did not prescribe the copy mechanism. This is sound because it preserves
the actual isolation boundary on supported host filesystems. It uses transient
memory for one bounded file; streaming would use less memory but introduce
another copy implementation. Failure never authorizes using the live bundle.

## Sound — high confidence

### Keep input authority out of the output receipt

When: review publication.

A completed review saves its safe submissions, ledger, manifest, and derived
decisions before publishing any of them. On retry it reopens the already-verified
input bundle by digest instead of repeating the bundle inventory in the saved
output plan. Both remain bound to the same private attempt.

The spec left the storage shape open. This is sound because a large input bundle
should not enlarge an unrelated output receipt. The bundle remains the single
input authority; the private attempt remains the single recovery owner.

### Keep Session routing in the CLI

When: capture admission.

A developer continues one Session across repositories or linked checkouts. The
CLI chooses its publication destination using the existing Session rules.
Preparation binds all content to that checkout. The journal refuses a graph
mixing checkouts and retains the binding for recovery and completion; it does
not infer another destination from the first or latest hook's directory.

The spec required durable replay without prescribing worktree binding. This is
sound because the writer must enforce preparation's destination, while a second
routing algorithm would disagree with legitimate cross-checkout workflows.

### Inspect the entire merged configuration

When: configuration publication.

A user enables automatic review after an existing extension value becomes a
known env secret. Factory checks the complete merged configuration while holding
its mutation lock, not only the new boolean. It refuses the update and preserves
the old bytes if a value or key requires redaction. Replacing a branch or model
with a marker could silently change operational behavior.

The spec did not place discovery relative to read, merge, and lock. This is sound
because the checked bytes are the proposed write. Configuration updates pay
bounded discovery cost under the existing lock; no second secret catalogue or
silent settings repair is introduced.

### Save a private receipt for human action retries

When: decision actions.

A user submits a note containing a secret, then retries after the env file changes.
Factory privately saves the safe action and a hash of the original request under
the existing action lock. The same request reuses the original action; different
content under the same action ID is refused. Already-prepared semantics are also
an exact retry. Neither the raw note nor its request hash enters Git.

The plan required stable retries without defining this binding. This is sound
because immutable actions must not change with today's dictionary. It adds a
bounded private receipt per prepared action. Coverage actions need no prose
receipt: they contain typed authority and unchanged Session locators.

### Share prepared GitHub evidence policy, not the raw provider parser

When: PR publication admission.

GitHub returns a title, timestamp, and head commit. Preparation can redact the
title or timestamp; a second pass must still recognize the resulting evidence.
The GitHub adapter validates the raw response. The repository owns the shared
prepared-evidence rule: validated containers and exact Git-identity paths remain
structural while other scalars are opaque sanitized data.

The plan did not locate this shared rule. This is sound because producer and
writer must not apply different SHA exemptions. Only documented, validated Git
fields retain their identities; a matching hash in an unknown explanation is
redacted. Optional Git-identity null remains structural too, so a deleted head
does not become an invalid commit even when an env secret equals null.

### Prefer redaction when a visible omission count matches a secret

When: publication integration.

With TOKEN=1000, shortening a 5,000-character result produces a visible marker
whose count is redacted. The structured transformation summary still records
exactly 1,000 omitted characters. Prose that resembles a generated omission marker
does not receive extra trust.

The plan required all-message redaction and an exact count without settling their
collision. This is a sound implementation choice because consumers use structured
counts, not marker parsing. It sacrifices a visible number in this rare case
rather than adding an exemption for arbitrary message text.

### Label combined stdout and stderr honestly

When: provider adapters.

A Claude hook supplies both output streams. Factory combines their text, applies
one result budget, labels it as combined output, and leaves the second stream
field empty. Dividing shortened text at the original boundary would be false
after redaction changed lengths. Separate budgets would retain twice the context.
Tool-call identity and error status remain available.

The spec left the reduced stream representation open. This is sound for review
evidence, but readers cannot infer which stream originally held each character.
The label prevents shortened evidence from pretending to be a terminal recording.

### Recheck the bytes that determine protection

When: env discovery.

An env file changes while another directory is scanned. Factory compares its
final bytes with the first read rather than assuming unchanged timestamps prove
unchanged content. The second read uses bounded chunks. Churn inside deliberately
excluded build directories does not invalidate discovery, provided their own
inspected identity was not replaced.

The spec required race detection without defining its proof. This is sound
because selected env bytes determine protection; unrelated excluded contents do
not. Discovery pays one extra bounded read without expanding dictionary scope.

### Match both env spellings and the union of overlapping secrets

When: shared matching policy.

An env value with an escaped newline may appear literally in copied file output
or decoded in JSON. Factory matches both forms. If two secrets overlap, such as
abc and bcde inside abcde, it redacts their union rather than leaving an edge of
either match visible.

The plan left these representation details open. This is sound because the same
known content should stay protected across ordinary provider encoding. It does
not add recursive decoding of arbitrary base64 or other opaque formats.

### Opaque scalars do not become structural by their type

When: shared JSON policy.

A provider payload contains a numeric password or an unknown null matching a
secret. Factory can replace that scalar with a redaction string. A validated
Factory counter or optional Git identity instead keeps its structural meaning.
Provider metadata is classified before transformation.

The plan explicitly covered decoded strings but not all scalar types. This is
sound because numeric credentials must not get a free bypass. Opaque evidence
consumers must allow changed scalar types rather than applying the raw provider
schema to already-prepared evidence.

### Keep native probes narrow and Docker control outside the reviewer

When: filesystem and installed verification.

A macOS-specific behavior needs a real macOS probe, but provider and repository
tests remain in Docker. Native probes therefore use bounded temporary files
without homes, hooks, or .factory. The installed Linux journey uses a disposable
outer container with the host Docker socket to launch a real sibling reviewer.
Shared absolute scratch paths let the daemon mount the CLI's actual prepared
files. Only the outer harness receives Docker control; the reviewer retains its
production mount allowlist and never receives the socket.

The spec left this test topology open. This is sound because it verifies native
behavior without touching live provider configuration or replacing Docker with
a fake command. It is test-only authority, not a new product capability.

### Preserve partial-coverage authority in the installed journey

When: installed verification.

Trimming a tool result can leave evidence partial even when the reviewer finishes.
The installed test therefore accepts that exact partial review through the real
localhost user action before checking that an unchanged command skips Docker.
It does not relabel reduced evidence complete just to obtain a no-op.

The plan did not specify this ordering. This is sound because it tests the user's
actual coverage transition without conflating model completion with evidence
completeness.

### Exercise private credential ownership with synthetic values

When: installed verification.

The disposable CLI owns a synthetic credential with private file permissions.
The real reviewer owner selects that file's validated numeric user for its
container. A public fixture would instead exercise the special test identity.
Neither fixture authenticates a model.

The plan required synthetic credentials but left permissions open. This is sound
because the test exercises private-file ownership without reading developer
credentials or changing their permissions.
