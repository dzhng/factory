# 2 — Typed reviewer submission tool

Depends on slice 1.

## Contract unlocked

Ship a Factory-owned stdio MCP server in the reviewer image with
`submit_choice`, `submit_audit_summary`, and `finish_audit`. Add the deterministic
bundle-local evidence index. The server emits bounded canonical draft events into
the existing output mount and never edits the bundle.

## API seam

The reviewer package owns server lifecycle and tool schemas derived from the
contract validators. Bundle construction owns evidence-handle assignment. The
contract owns a single draft-event reader/fold; the server must consume that
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

## Checkpoint — 2026-09-06

The pure fold moved into contract, with direct imports from both consumers;
review retains publication authority. This avoids the reviewer→review→reviewer
package cycle without adding a package or a compatibility export. Shared field
definitions supply the tool JSON Schemas and validator field rules.

The pinned Codex 0.144.4 and Claude 2.1.261 image packages expose no importable
MCP SDK. A bounded implementation follows the official
[stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
and [tools protocol](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
It introduces no dependency, listener, network operation, runtime download, or
mount. The networkless image-build stage installs only the reviewer's workspace
dependency closure and emits one bundled server; build context excludes env,
Factory state, dependency output, and Git metadata.

The deterministic human checkpoint is:

```sh
bun run packages/test-harness/src/run-audit-submissions.ts
```

It builds the production-shaped reviewer image, runs its packaged server without
network access as non-root, and prints a three-verdict synthetic ledger in shared
presentation order. Multiline scenarios and nested assertions survive the typed
protocol unchanged; compact handles resolve to exact cited objects. Verdict:
the report remains independently understandable and the draft finishes explicitly.
This certifies protocol and packaging, not production provider configuration.

The first real-process test failed because the server did not exist, then passed.
Tool-schema discovery and actionable closed errors each had a red/green tracer.
Bypassing shared-fold admission made the key-conflict test fail; restoring it
passed. Bypassing evidence-index verification admitted a forged mapping under a
recomputed digest; restoring verification rejected it. Docker tests additionally
cover exact retry, finish ordering, malformed direct journal content, aggregate
limits, and SIGKILL after acknowledgement followed by restart/retry. The journal
is never replaced or repaired; an OS-released lock and fsync preserve acknowledged
events. Synthetic archived bundle manifests were regenerated for the new index;
real historical provider evidence was not read or rewritten.

Owning gates: contract/domain/review 74 tests, reviewer 31, planning/bundles 30;
all passed. All 13 workspace type and build gates passed. The packaged-server
probe finished with a 3,582-byte canonical draft and needs-user/unsound/sound
entries. Provider configuration and the installed provider journey remain slice 4.

The independent bundled Codex review found no actionable regressions. It reran
the seven focused audit tests; its sandbox could not access Docker, so the owning
Docker gates above were run separately in the permitted test environment.
