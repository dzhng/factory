# 1 — Shared policy and safe discovery

## Contract and seam

Create `@factory/sanitization`, owning one ephemeral repository secret context
and pure text/JSON transformations under the [target contract](../contract.md).
Expose typed preparation results with safe bytes/text, transformation summary,
or a fixed unavailable reason. Callers must not obtain or serialize the dictionary.
Discovery and pure matching are separate functions within this owner so string
behavior can be tested without a filesystem. Do not wire a byte-rewriting store
wrapper or a user-facing command.

## Red/green and inspectable result

First pin behavior using synthetic inputs: nested ignored env files, duplicate
keys, multiline/quoted values, literal shell substitutions, short sensitive
values, overlaps, JSON escaping/keys, unsupported syntax, and normal prose.
Pin boundaries at 3,999/4,000/4,001 code points, astral Unicode, and a credential
crossing the would-be trim boundary. Inputs with no match must retain their text.
The shared result reducer accepts ordered text blocks; test its aggregate budget.

In Docker test no-follow file and directory reads, replacement races, exclusions,
and discovery ceilings. A bounded synthetic large tree and repetitive text probe
must finish within a documented budget without unbounded regex work. Never use
the developer's repository env files as fixtures.

Add a test-harness fixture report showing only synthetic before/after text and
fixed reasons. Give its exact runnable invocation in this slice when it exists.
Human feedback on readability is non-blocking; record a verdict and proceed.

## Handoff and freedoms

Keep existing consumers green; this slice introduces a tested primitive, not a
claim of production protection. Delegate internal matcher/parser data structures,
function names, and the initial tested provider-pattern catalogue. Do not delegate
thresholds, marker semantics, discovery failure behavior, or dictionary retention.
Evidence of unacceptable false positives can change the policy through an explicit
spec update. Commit and push when the seam and tests are green.

## Evidence

The shared policy has 11 passing pure tests, with red/green coverage for quoted
credential values, overlapping matches, decoded JSON, resource limits, and the
aggregate Unicode tool-result budget. Package type and lint checks pass. The
independent policy re-review reported no actionable defects after the quoted-
value regression was fixed.

Run `bun run --cwd packages/test-harness lab:sanitization-policy` for the synthetic
readability and bounded-work report. The report retains the reasoning sentence,
redacts its secret, and shows the tool result's head, omission marker, and tail.
The repetitive-input check processes 2.54 MB within a five-second ceiling.
Verdict: readable context is retained; provider envelope handling is slice 3.

The confined reader and nested ignored-env integration run under the repository
Docker runner. The integrated reader and policy tests pass (35 tests), including
a deterministic same-timestamp byte mutation and excluded-content churn. The
reader's owning Docker suite passed 90 tests in its isolated worktree; its final
independent review was clean. A bounded native macOS FIFO probe also passed.
Slice 1 is complete. Source and PR publication are the next boundary, not covered
by this primitive's closeout claim.
