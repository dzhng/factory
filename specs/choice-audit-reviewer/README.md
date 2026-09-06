# Choice-audit reviewer

Factory's reviewer should productize the `audit-choices` workflow: trace the
implementation history, surface choices the user did not make, explain each one
standalone, and judge it. The model should submit typed records through a narrow
Factory tool instead of hand-authoring JSONL.

## Next Agent Prompt

Status: slices 1–3 and provider wiring implemented; publication closure and combined release gates remain. Last updated: 2026-09-06.

Finish the combined journey in [slice 4](slices/04-integration.md) next. Inspect [slice 3's visual checkpoint](assets/presentation/README.md) at integration; fresh-agent visual critique was unavailable. Read this README, the
[target contract](contract.md), `SECURITY.md`, and the repository's write-tests
skill before changing behavior. This is a clean cutover for an unlaunched
product: delete the generic reviewer-output contract as its consumers move; do
not add compatibility parsing, migration machinery, or dual output modes.

- [x] [1 — Choice-audit semantics and public ledger](slices/01-audit-contract.md)
- [x] [2 — Typed reviewer submission tool](slices/02-submission-tool.md)
- [x] [3 — Human-readable choice presentation](slices/03-presentation.md)
- [ ] [4 — Provider integration and partial-output journey](slices/04-integration.md)

No product decision is blocked. The important warning is that tool calls improve
serialization reliability; they do not make model judgments authoritative.
Factory still validates citations and derives all IDs itself. Update this prompt
and the owning slice with verification evidence before ending each pass, then
commit and push each green milestone.

Contract owns the shared `acceptAuditDraft`/`readAuditDraft` fold and validators;
review owns publication. The image packages `/opt/factory/audit-server.js`, invoked
as `bun <server> <bundle-path> <exact-bundle-sha256> <output>/submissions.jsonl`.
It verifies the manifest evidenceIndex, resolves handles to exact ObjectRefs,
and fsyncs canonical events before replying. Private attempts keep submissions
separate from providerOutput. Both provider adapters use strict Factory-owned MCP
configuration. Pinned executable probes verify configuration and discovery;
the installed synthetic journey separately verifies execution and publication,
not real-model inference. Preserve the main sanitizer's
`transformation` metadata when integrating publication.

Load-bearing choices are banked in [choices.md](choices.md). Effect controls
presence; verdict adds attention without rewriting lifecycle or human status.
The CLI selects an exact failure verdict, not an invented verdict ordering.

## Product outcome

The reviewer audits decisions, not code style or generic defects. A successful
review leaves a human-readable ledger that can replace reading the diff:

- every entry explains the triggering situation, what Factory observed, and the
  meaningful alternative in plain language;
- each entry names the gap that forced the agent to choose and the future reach
  of that choice;
- each entry has a `sound`, `unsound`, or `needs-user` verdict and confidence;
- unsound entries state the corrected decision, while needs-user entries carry a
  reversible provisional call; and
- later reviews explicitly assert, remove, or contradict a choice—silence never
  rewrites history; and
- all claims cite exact evidence from the immutable bundle.

Choices explicitly made by the user or delegated by a spec are not rediscovered
as agent-made choices. An empty audit is allowed only with a cited explanation of
what histories were checked and why no undeclared choice was found.

Generic code findings are outside this analyzer. If Factory later offers code
review, it should be a separately named analyzer with its own prompt and ledger,
not a second meaning hidden inside choice audit.

## Architecture

`bundle evidence → choice-audit model → Factory submission tools → validated draft → acceptance → decision fold`

After slice 1, submission tooling and browser presentation can proceed in
parallel. Provider integration waits for both so its installed journey verifies
the actual human review surface, not only stored records.

The reviewer package owns the prompt and the ephemeral submission server. The
contract package owns the durable choice-ledger schema. Review acceptance owns
the transition from a bounded draft to immutable repository records. The domain
package owns decision folding. No layer independently parses model-authored JSON.

The submission server is a local stdio MCP server shipped inside the immutable
reviewer image. Both Codex and Claude receive only its declared tools plus their
existing read-only evidence tools. The server resolves compact evidence handles
to full bundle `ObjectRef`s, validates each submission immediately, and writes
canonical draft events into the existing output mount. The provider's final text
is diagnostic only and never becomes semantic review history.

## Why not the alternatives?

A CLI with many flags moves the failure from JSON commas to shell quoting,
multiline prose, and structured assertion escaping; Claude also currently has no
shell tool. A CLI that reads files/stdin could work, but reproduces the typed tool
protocol with worse provider ergonomics.

A permissive JSON/JSON5 parser accepts trailing commas but does not solve wrong
field names, copied object references, Markdown fences, mixed prose, or incomplete
objects. Recovery heuristics can also guess a different meaning than the model
intended. Strict validation belongs at each tool call, where the model can see a
precise error and retry.

## Verification and coordination

Use synthetic bundles and provider fixtures; never use live transcripts or
credentials in tests. Run the narrow parser/tool tests first, then reviewer and
review workspaces, then the installed Docker journey. Existing isolation,
digest-pinned images, partial-review handling, incremental coverage, and decision
confirmation must remain green.

Any browser-visible slice must use deterministic local fixtures and run
`screenshot-critique` as its last visual check. Compare wide and narrow candidates
against current baselines with `compare-screenshots`; the verdict is whether the
new ledger communicates the audit more clearly, not whether pixels stay the same.

This spec complements the active evidence-sanitization plan. Sanitization must
run before draft events or provider diagnostics can enter `.factory`; the
submission tool must never become an unsanitized bypass. If the two implementations
overlap, land the shared publication contract once and make both consumers use it.

The write-spec fan-out step was intentionally skipped because this spec was
created in a side conversation where sub-agents are prohibited. The plan is
grounded in the current reviewer, acceptance, contract, domain, and isolation
owners plus the supplied audit-choices skill.
