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
