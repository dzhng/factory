# Research and current seams

## Structured tools are the native seam

The [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
defines typed tool inputs with JSON Schema and correctable tool errors. The model
still produces structured arguments internally, but the provider owns encoding;
the Factory server receives parsed values and validates them at the call boundary.
That is materially different from asking the model to print a flawless JSONL file.

[Claude Code's CLI](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
supports configured MCP servers and explicit tool allowlists. Factory already
invokes Claude with strict MCP configuration, currently empty, and without Bash.
A Factory stdio server fits that boundary without granting a general shell.

## Current implementation seams

- `packages/reviewer/src/adapter.ts` owns one shared prompt and provider argv.
  Today it asks both providers to hand-author exact JSONL and copy complete object
  references from the bundle.
- `packages/review/src/output.ts` tolerates a valid prefix but rejects a line for
  any JSON syntax, exact-key, enum, citation, duplication, or bound failure.
- `packages/review/src/acceptance.ts` publishes the bounded provider response and
  derives the ledger/disposition from parsed lines.
- `packages/contract/src/index.ts` owns generic summary/finding/decision entries;
  the domain decision fold consumes decision effects and assertions.
- `packages/reviewer/src/probe.ts` already owns the digest-pinned, non-root,
  read-only-bundle and bounded-output container lifecycle. The submission server
  belongs inside that existing image and mount plan.

## Rejected approaches

Shell parameters are friendly for short scalars but brittle for multiline ELI5
scenarios, citation lists, and structured decision meaning. Temporary input files
would require a writable model workspace and another file-validation protocol.

JSON5 or extraction from Markdown can recover superficial formatting mistakes,
but makes the authority ambiguous when multiple objects, comments, prose, or a
truncated tail are present. A tolerant parser also cannot give the model feedback
during the run. Keep strict canonical JSON at Factory-owned storage boundaries;
move model interaction to typed, retryable tools.

Structured-output modes offered by provider CLIs remain provider-specific and
still return one terminal response. The MCP submission stream works across both
reviewers, preserves accepted work before a timeout, and lets Factory own one
semantic contract.
