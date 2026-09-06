# 2 — Typed reviewer submission tool

Depends on slice 1.

## Contract unlocked

Ship a Factory-owned stdio MCP server in the reviewer image with
`submit_choice`, `submit_audit_summary`, and `finish_audit`. Add the deterministic
bundle-local evidence index. The server emits bounded canonical draft events into
the existing output mount and never edits the bundle.

## API seam

The reviewer package owns server lifecycle and tool schemas derived from the
contract validators. Bundle construction owns evidence-handle assignment. Review
acceptance owns a single draft-event reader/fold; the server must consume that
same validator rather than re-declaring record shapes. Exact retries are
idempotent, conflicting keys are correctable errors, and completion is explicit.

Start with one failing test that invokes the server as a real stdio process,
submits a choice using a compact evidence handle, and observes canonical output
with the full ObjectRef. Add one behavior at a time: validation retry, exact
duplicate, conflict, completion, aggregate limits, abrupt process death, and
malicious direct output-file content. Falsify the trust-boundary test once by
bypassing validation, then restore it.

## Human-visible checkpoint

Add a deterministic CLI probe that drives the server protocol without a model and
prints the resulting sanitized ledger/draft summary. It must demonstrate that
multiline prose, nested assertions, and citations need no shell escaping or
handwritten JSONL. Record invocation and verdict here.

## Must remain green and delegated choices

Reviewer image reproducibility, immutable bundle verification, output bounds,
cleanup, and no-host-fallback isolation remain green. The server adds no listener,
network request, dependency download, or new mount. Delegate MCP library choice
only after checking whether the pinned provider/runtime already supplies a usable
implementation; otherwise prefer the smallest protocol implementation. Do not
delegate tool count, evidence-handle authority, completion semantics, or storage
validation. Review, audit choices, update handoff, commit, and push.
