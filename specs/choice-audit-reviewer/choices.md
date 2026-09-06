# Implementation choices

## Sound · medium confidence — Describe conditional tool fields and enforce them at admission

When: slice 4 pinned-provider integration.

A reviewer judges a choice unsound and must supply the corrected decision. The
tool description explains that requirement; the server refuses the submission
with a fixed correction message if it is absent. The advertised JSON Schema is
a flat object because the pinned Claude client dropped the choice tool when its
schema used conditional clauses. Keeping those clauses would make a formally
precise schema unusable; inventing separate verdict tools would expand the agreed
three-tool surface. The shared runtime validator still checks the exact rules
before acknowledging or storing anything.

Gap: the plan did not settle client-specific JSON Schema expressiveness.
Reach: future conditional fields need descriptive tool metadata and an admission
rule; client schema acceptance alone never proves a valid submission. Verdict:
sound because interoperability changes no accepted semantic value.

## Sound · medium confidence — Disable Codex web search for bundle-only review

When: slice 4 provider configuration.

A reviewer sees a library name in a captured implementation. It should judge the
choice against the supplied history, not silently add mutable web evidence that
cannot be cited from the verified bundle. The adapter disables Codex's built-in
web search while preserving the container's existing model-service network
access. Leaving search enabled would invite uncaptured evidence without adding a
durable citation owner.

Gap: the plan required exact bundle citations but did not explicitly choose the
web-search switch. Reach: future external research needs an explicit evidence
capture path before it can support this audit. Verdict: sound because the audit's
authority remains the immutable input the host verified.

## Sound · high confidence — Use closed configuration sources instead of Claude safe mode

When: slice 4 pinned-provider experiment.

Factory starts Claude with its native login and its own submission server. Safe
mode removes even that explicitly supplied server, leaving the model unable to
submit an audit. Factory instead uses restricted mode, empty setting sources,
strict MCP configuration, and explicit read/submission tool permissions inside
the already isolated container. Enabling ordinary user settings would let a
saved hook run; a synthetic poisoned-home test proves that difference. Bare mode
would remove native login support, so it is not an equivalent substitute.

Gap: the plan chose strict tool authority but did not specify how pinned safe
mode interacts with explicit servers. Reach: provider upgrades must rerun the
executable configuration probe, not just argument assertions. Verdict: sound
because the closed source boundary preserves both native authentication and the
required tools, without another host mount or broader permissions.

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

## Sound · high confidence — Missing scope disables actions, not reading

When: slice 3 independent-review correction.

A cloned repository can contain verified receipt-retention choices before its
owner configures a canonical branch. Those explanations remain readable, marked
unclassified and read-only. The browser receives neither an action fingerprint
nor invented lifecycle or human status.

Gap: the old projection withheld the entire fold when policy was absent; the spec
required readable standalone choices without defining this state. Reach: future
missing-authority states should not silently erase verified audit explanations.
Verdict: sound because reading evidence is distinct from authorizing a mutation.
Confidence: high; projection and real-browser regressions cover both boundaries.

## Sound · medium confidence — Standalone choices get the primary full-width panel

When: slice 3 presentation.

A reader deciding whether to keep a year of payment receipts now sees the
provisional retention period and how to reverse it next to the scenario. The
ledger sits above the existing session and PR layout, with two readable cards
across on wide screens and one on narrow screens. Keeping the old sidebar would
leave little room for the required explanation or require hiding it behind a
disclosure. The tradeoff is that session cards move farther down the page.

Gap: the spec made choices primary but did not assign their screen area. Reach:
future audit fields must fit this reading hierarchy without turning the ledger
back into headlines alone. Verdict: sound because the main task is judging the
choice without opening a transcript; comparison captures show that task directly.
Confidence: medium; independent integration visual inspection remains pending.

## Sound · high confidence — Citation detail is disclosed, decision guidance is not

When: slice 3 presentation.

The receipt-retention card always shows its scenario, gap, reach, and reversible
provisional decision. Its implementation point and source review/entry IDs are
also visible. A native disclosure reveals evidence role, full SHA-256 digest,
and locator. Sending the complete object reference or raw submission preview
would give the browser storage details without improving this explanation.

Gap: the spec required compact provenance but delegated disclosure mechanics.
Reach: this is a read-only citation display, not an object browser or new evidence
authority. Exact references remain in durable records; action IDs and the fold's
state fingerprint pass through unchanged. Verdict: sound because optional
provenance detail does not hide the user's required decision. Confidence: high.

## Sound · high confidence — Canonical scope breaks confidence ties

When: slice 3 presentation.

If two needs-user choices both have low confidence, the canonical-branch choice
appears before a proposal from another branch. A medium-confidence canonical
choice still follows both: scope does not override the required least-confident
order. Remaining ties use priority and stable semantic/observation identifiers.

Gap: the spec required canonical priority without defining its interaction with
confidence ordering. Reach: ordering is owned by the domain projection, so every
browser receives the same groups without inventing verdict semantics. Verdict:
sound because it preserves both rules without changing lifecycle or human status.
Confidence: high.

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
