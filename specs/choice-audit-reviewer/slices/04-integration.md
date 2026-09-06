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
