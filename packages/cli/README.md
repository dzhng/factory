# CLI

The CLI composes Factory's domain owners. It discovers repository and provider
locations, applies hook patch plans, routes a native Session to its first
initialized repository, and invokes capture recovery. It never constructs
repository-owned paths or writes `.factory` directly.

`factory capture` is deliberately fail-open for Codex and Claude Code: after
input classification it always emits the provider's valid empty response and
exits successfully, even when durable capture or materialization fails. Raw
evidence that reached the journal remains recoverable.

Global hook ownership is private operational state. Exact recorded
fingerprints authorize removal; foreign, duplicate-looking, and user-edited
entries remain untouched. `factory doctor` is read-only unless `--repair` is
explicit.
