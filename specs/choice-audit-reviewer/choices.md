# Implementation choices

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
