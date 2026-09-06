# 4 — Provider integration and partial-output journey

Depends on slices 2 and 3.

## Contract unlocked

Configure both Codex and Claude to use only the pinned Factory submission server
for semantic output. Remove JSONL authoring instructions and response parsing.
Accept canonical submission events, publish the choice ledger, and preserve valid
partial work when the provider stops before `finish_audit`.

## API seam

Provider adapters own strict MCP configuration and tool allowlists. They share one
audit prompt and one server contract. Container execution returns termination plus
the bounded draft stream/completion state; acceptance derives disposition and IDs.
Provider final text is private diagnostic context, not a semantic fallback or
committed response.

Write red adapter and execution tests first. Pin that Claude gains no Bash or
foreign MCP server, Codex ignores user configuration, both see the same Factory
tools, and prompt text carries the audit-choices behavior without JSON examples.
Exercise provider success, tool correction, duplicate retry, timeout after valid
choices, completion with zero choices, prompt injection from evidence, and direct
malformed output writes.

Finish with an installed Docker journey using both deterministic provider fakes:
read an immutable transcript/spec/code bundle, submit multiple verdicts, stop one
review midstream, rebuild from committed data only, and verify citations, decision
attention, sanitization, cleanup, unchanged incremental no-op behavior, and the
browser projection from slice 3. The report must display the final human-readable
choice ledger and exact authority; missing real-provider credentials are not
required because serialization is the tested external boundary.

## Must remain green and delegated choices

Run reviewer/review/domain/web workspaces, reviewer isolation, local UI, review
CLI/PR journeys, repository-wide build/format/lint/types/tests, and supported-
platform release gates. Update `SECURITY.md`, public format rationale, and package
READMEs to describe the typed submission boundary and private provider diagnostics.
Delegate diagnostic wording and fixture organization, not semantic fallback, tool
authority, or complete/partial/failed rules.

Run whole-feature review and choice audit. Consolidate the choices ledger, archive
this spec with close-spec, commit, and push. Do not tag or publish npm without a
separate release request.

## Backend checkpoint — 2026-09-06

Adapters now bind one stdio server to the exact bundle digest and share the
evidence-aware audit prompt. CLI preflight validates settings independently of
invocation construction. Provider final text remains diagnostic-only; no output
fallback or publication ownership changed in this pass.

The pinned CLI experiment exposed two failures that argument snapshots missed:
Claude safe mode suppressed every explicitly configured tool, and a top-level
conditional JSON Schema caused its client to drop submit_choice. Restricted mode,
empty setting sources, strict MCP configuration, and explicit tool permissions
preserve the intended boundary without disabling native OAuth. A flat advertised
schema with descriptive conditional fields keeps all three tools visible; the
shared runtime validator still enforces every verdict/effect condition. See the
official [Claude CLI controls](https://code.claude.com/docs/en/cli-reference) and
[Codex MCP configuration](https://developers.openai.com/codex/mcp/), plus the pinned
executable probe for version-specific behavior.

`bun run packages/test-harness/src/run-audit-submissions.ts` builds the image and
probes both real pinned CLIs against a synthetic loopback model boundary with no
network or real credentials. Claude advertises the three exact tools; Codex
registers Factory for deferred discovery. Poisoned user settings, hooks, plugins,
and a foreign MCP configuration do not execute. Deliberately reopening Claude
user settings made the sentinel assertion fail; restoring isolation passed.
This is configuration/discovery authority, not inference or a real-model audit.

`bun run packages/test-harness/src/run-review-execution.ts` drives both
deterministic providers through the packaged server. It prints complete and
timed-out three-verdict ledgers, explicit zero-choice completion, and refusal of
malformed direct output. The fixtures retry an invalid unsound choice with a
correction and repeat accepted choices exactly; multiline scenarios, nested
assertions, and exact citations survive. Oversized direct output remains bounded.
Its publication store is synthetic. The installed combined journey, sanitized
publication/recovery integration, browser projection, and final release-shaped
gates remain integration work; this backend checkpoint does not close the spec.

Owning gates passed: contract/domain/review 74 tests, reviewer 32 tests, both
focused Docker probes, and all 13 workspace type/build/lint gates plus formatting.
The independent bundled Codex review found no actionable regressions and reran
the four adapter tests; owning Docker journeys were verified separately.

Release must publish the final reviewer image and update the default immutable
reference and live-capture image pin from its observed digest. The prior shipped
image does not contain the submission server. The image workflow currently
watches Docker files only, so source-only server/schema changes also need explicit
dispatch or a corrected dependency path filter. Neither a local test image nor
a passing source build certifies that default remote image.
