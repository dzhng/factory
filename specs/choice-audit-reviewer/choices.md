# Implementation choices

## Sound · medium confidence — Evidence handles live inside the bundle manifest

When: slice 2 submission tooling.

A model needs to cite a captured object without copying a long digest and all its
metadata. Factory adds a compact lookup table beside the bundle's existing
inventory: `e1` refers to the first full reference in canonical order. The model
submits that handle; the server expands it back to the exact reference. A separate
index file would need its own path and digest entry, while ordinal-only inference
would force clients to recreate the ordering rule themselves.

Gap: the plan required a deterministic index but did not choose its representation.
Reach: manifests grow by a bounded copy of their reference inventory; their
existing byte ceiling still applies. Handles change when inventory changes and
never become durable identity. Verdict: sound because one verified manifest
binds the mapping without another file-publication rule.

## Sound · high confidence — The submission journal is also the lock inode

When: slice 2 durable tool acknowledgement.

Two server processes may start after a provider retry. Both lock the same journal
file using the existing operating-system lock, then read, validate, append, and
sync while holding it. The second process sees the first's event and returns
success without appending a duplicate. The journal is never renamed or replaced;
process death releases its lock automatically. A separate lock artifact would
add another allowed output file and its cleanup lifecycle.

Gap: the plan required durable idempotent appends without choosing concurrency
ownership. Reach: all honest writers must preserve this file identity and use the
same lock. Exact retries also sync before acknowledgement, covering a predecessor
that wrote bytes but died before syncing. Verdict: sound because serialization
and crash release reuse a proven repository primitive without another artifact.

## Sound · high confidence — Corrupt journals remain evidence, not repair targets

When: slice 2 hostile-output handling.

The provider can write its output directory directly and leave a malformed line
after an acknowledged choice. A restarted tool refuses to append to that file;
it does not delete the malformed tail or guess what the model meant. Host
acceptance can still preserve the earlier valid choice as a partial audit.
Repairing the file inside the tool would hide what happened and might turn an
incomplete attempt into an apparently clean finish.

Gap: the plan required malicious direct-output tests but did not prescribe
server-side repair behavior. Reach: a damaged attempt must end as partial or
failed and be retried as another attempt; its valid history remains available.
Verdict: sound because only validation, not rewriting evidence, can grant authority.

## Sound · medium confidence — Failure selection names one verdict

When: slice 1 contract cutover.

A CI command previously selected a severity threshold. Choice audits instead
judge whether a decision is wrong or belongs to the user; those judgments have no
natural severity ordering. The command now selects exactly `unsound` or exactly
`needs-user`. Selecting unsound does not fail for a user-only choice, and selecting
needs-user does not fail for a wrong decision. Inventing an order would silently
turn one policy into the other.

Gap: the spec removed generic severities without choosing replacement CLI
enforcement semantics. Reach: automation must explicitly select the judgment it
wants to enforce; the old severity options are rejected. Verdict: sound because
exact selection preserves opt-in enforcement without inventing product priority.

## Sound · medium confidence — Derived decisions retain the whole explanation

When: slice 1 domain projection.

After an audit is accepted, Factory creates a rebuildable decision observation
for the history fold. It copies the validated scenario, gap, reach, verdict, and
evidence, as well as the assertion. A later browser can explain a choice and show
its corrected or provisional decision directly. Keeping only a reference would
make every projection resolve the review again to recover these essential fields.

Gap: the plan required verdict-aware folding but did not specify the derived
observation's complete payload. Reach: observations are larger, but are still
admitted only when their bytes reproduce exactly from the authoritative review.
Verdict: sound because all consumers receive the same validated explanation and
cannot substitute an independently reconstructed judgment.

## Sound · high confidence — Partial scope summaries are useful without completion

When: slice 1 acceptance seam.

A reviewer submits a cited account of what it read, then crashes before submitting
choices or finishing. Factory preserves that account as a partial audit. It does
not claim that no choices exist. A zero-choice audit can finish only after an
explicit no-choice rationale. Rejecting the early summary would discard useful
work; treating it as complete would manufacture assurance from silence.

Gap: the plan distinguishes partial valid output from completed empty audits,
but leaves durable summary optionality unspecified. Reach: a partial ledger may
have entries without a summary, or a scope summary without choices; completion
remains a separate validated fact. Verdict: sound because it retains evidence
without overstating authority.

## Sound · high confidence — Private diagnostics have a separate bounded stream

When: slice 1 reviewer crash boundary.

A provider writes final prose while the submission tool records semantic events.
Factory keeps those as two private streams while publication is pending, so crash
recovery can repeat acceptance and the live capture probe can inspect provider
completion independently. Only validated submissions can become portable records.
Using final prose as a fallback would reintroduce the removed model-JSON parser;
discarding it would remove the existing diagnostic oracle.

Gap: the clean cutover did not specify how private raw-attempt recovery retains
both channels. Reach: each channel is bounded at 1 MiB; their base64 encoding plus
fixed facts fits the private 3 MiB state ceiling. The forthcoming sanitizer must
still govern every committable submission. Verdict: sound because the bounds
follow the actual two-channel schema and preserve a distinct private trust domain.
