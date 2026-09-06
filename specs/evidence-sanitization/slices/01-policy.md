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
