# 1 — Choice-audit semantics and public ledger

## Contract unlocked

Replace the generic review ledger with the [choice-audit contract](../contract.md)
and make the decision fold's treatment of each verdict explicit. Rewrite the
review prompt from the supplied audit-choices principles. This slice may use an
in-memory typed submission seam in tests; it does not yet integrate MCP/provider
execution.

## API seam

The contract package owns `ChoiceAuditEntry`, `ChoiceAuditSummary`, and their
strict validators. Review acceptance owns deterministic IDs and aggregate bounds.
Domain owns projection into current decisions and required human attention.
Remove generic finding/summary/decision variants and stale effects in the same
pass; no aliases or compatibility parser survive.

Before implementation, write one red test through review acceptance showing a
full sound/unsound/needs-user audit with exact citations and standalone fields.
Add tracer tests for verdict-required fields, explicit zero-choice rationale,
stable choice-key reuse, and the domain projection. Prove the tests fail against
the current generic contract before changing production code.

## Human-visible checkpoint

Produce a synthetic ledger report containing one entry per verdict, sorted in the
same order the UI will present. The reviewer should be able to judge each entry
without opening code. Record the command and verdict in this file; feedback on
wording may refine field descriptions but cannot collapse the standalone scenario.

## Must remain green and delegated choices

Bundle verification, citation authority, decision confirmation/dispute actions,
partial coverage, and prior-ledger replay remain green. Delegate internal type
names and validator factoring. Do not delegate the audit categories, verdict
meaning, required fields, no-choice rule, or separation from generic code review.
Run the repository review and audit-choices passes, update the handoff, commit,
and push.

## Shipped checkpoint — 2026-09-06

Before editing, the mapping was fixed as follows: assert establishes or materially
changes a non-null assertion; remove explicitly retires it with null; contradict
records an incompatible non-null assertion. Existing supersession and disputes
remain exact and append-only. Silence does nothing. Assertion plus effect is the
material fingerprint; changed verdict/prose/confidence is not a material change.
Unsound and needs-user independently raise attention, retaining their corrected
or provisional decision. Human confirmation does not suppress analyzer attention.

Acceptance admits strict canonical events, preserves valid prefixes, derives IDs,
checks exact full citations, rejects conflicting keys without overwrite, and
enforces both submitted and derived-ledger byte bounds. There is no generic parser
or final-text fallback. Repository readers preserve the submission journal as one
inspection artifact while validating every event independently.

The [synthetic report](../assets/audit-contract-report.md) is readable without code
and uses acceptance's needs-user/unsound/sound order. Wording verdict: each entry
walks a triggering event, current behavior, alternative, missing direction, and
future consequence; corrected/provisional decisions remain separate and explicit.
Its exact accepted ordering can be reproduced from the worktree root:

```sh
bun -e 'import {checkpointChoices,writerChoice} from "./packages/test-harness/src/choice-fixtures"; import {acceptAuditDraft} from "./packages/review/src/audit"; console.log(acceptAuditDraft(checkpointChoices(writerChoice.evidence).map(choice=>({kind:"choice",choice})),writerChoice.evidence.map(c=>c.object),"review_00000000000000000000000001").entries)'
```

Verification: full three-verdict acceptance test failed against the original
generic parser, then passed. Verdict attention, derived-ledger size, and immutable
input snapshots each had explicit red/green tracers. Contract/domain/review:
74 tests; repository Docker: 70; review-plan: 29; reviewer: 26; CLI Docker: 56.
`lab:review-plan` and `lab:review-execution` passed on synthetic fixtures.
Typecheck and lint passed in all 12 workspaces. Only synthetic archived
review-plan assets were regenerated; real historical evidence was untouched.

Closeout shape/diff/docs review removed duplicate validation and stale contract
language. Independent bundled Codex review found duplicate entry IDs were no
longer rejected alongside duplicate choice keys. Confirmed with a failing test,
then restored the durable identity invariant; the regression is green. No
findings were dismissed. The choices audit is banked beside this plan.

Browser changes are the minimal schema-consumer cutover, not the slice 3 visual
checkpoint. No visual quality claim or real-provider MCP claim is made here.
The full release-shaped journey and repository-wide closeout belong to slice 4.
