# Typed submission rationale

## Structured tools are the native seam

The [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
defines typed tool inputs with JSON Schema and correctable tool errors. The model
still produces structured arguments internally, but the provider owns encoding;
the Factory server receives parsed values and validates them at the call boundary.
That is materially different from asking the model to print a flawless JSONL file.

[Claude Code's CLI](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
supports configured MCP servers and explicit tool allowlists. Factory invokes
Claude with strict Factory-owned MCP configuration and without Bash.
A Factory stdio server fits that boundary without granting a general shell.

## Ownership

The [reviewer](../../packages/reviewer/README.md) owns the shared prompt,
provider configuration, and isolated submission server. The
[public contract](../../packages/contract/README.md) owns the canonical draft
fold; [review acceptance](../../packages/review/README.md) validates and publishes
its prepared result. Typed tools improve encoding reliability without making
model judgments authoritative or creating another container trust boundary.

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
