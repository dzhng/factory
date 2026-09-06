# Reviewer boundary

This package owns the security boundary between a verified review bundle and an
ephemeral Docker reviewer. Mount planning is pure and rejects host-path overlap
or provider-auth targets outside the selected provider's namespace. Execution
then observes the container Docker actually created, rather than treating the
requested arguments as proof.

Resource ceilings come from the effective configuration, while security isolation
is fixed. The observed Docker configuration must match the requested CPU, memory,
and process limits before execution; memory cannot silently spill into extra swap.
The host owns the separate execution deadline and cleanup even if the provider
does not cooperate.

The reviewer package never discovers repository state or review subjects. It
uses each authenticated CLI's conventional provider-owned credential location by
default, with explicit file paths reserved for nonstandard installations and
controlled tests. Every file is validated before the package returns an
identity-bound read-only mount. The test harness owns fake images, live journeys,
and human-readable reports.

Bundle verification mints a private capability only for a `ready` plan. The
execution boundary re-verifies that exact digest before using credentials or
starting Docker, so a path or caller-built object cannot authorize a review.
Automatic selection chooses one reviewer from exact attempted Session evidence;
weak context may inform analysis but cannot choose whose harness reviews it.

The host copies and re-verifies the exact declared bundle into a private runtime
snapshot. Docker mounts that snapshot read-only at `/review-input`; the runner
enumerates and hashes it before invoking one provider directly with Factory's
fixed arguments, environment, prompt, and response channel. The provider never
receives the live bundle path. Only bounded, validated audit submissions can
cross back into portable history. Provider final text and logs remain diagnostic
private runtime data, separate from the canonical submission stream. Recovery
retains both streams until acceptance; final text is never a fallback when
submissions are absent.

Snapshot copying reads bounded, no-follow source bytes and creates destination
files exclusively before making them read-only. This avoids filesystem clone
behavior that can leave a copied read-only file unchmodable on a shared host
mount; complete bundle verification still authorizes the resulting snapshot.

The image contains a fixed stdio submission server. It verifies the bundle,
resolves bundle-local evidence handles, and appends canonical events only after
the shared contract fold admits them. The journal itself is the OS-released lock
inode: it is never replaced, acknowledged writes are synced, and restart can
accept exact retries without overwriting history. Malformed direct journal bytes
are refused, not repaired. Both provider adapters bind their sole MCP server to
the verified bundle digest; their shared prompt treats sanitized evidence and
omissions as limitations, not instructions or permission to reconstruct secrets.
Settings validation is separate from invocation construction, because CLI
preflight happens before the immutable bundle exists.

Claude's safe mode suppresses explicitly configured tools, so the adapter uses
restricted mode and closed setting sources instead. The precise isolation
guarantees are in [`SECURITY.md`](../../SECURITY.md). The advertised tool schema
is a portable flat object; conditional verdict rules remain authoritative in the
shared validator, with closed correction feedback. Codex may defer tool discovery;
the submission server, not a client's discovery strategy, owns the tool surface.

The server is a bounded JSON-RPC implementation of the MCP stdio lifecycle and
tool surface. Neither pinned provider package exports a reusable MCP SDK, so no
runtime dependency or download is introduced. The networkless image build stage
bundles only workspace runtime dependencies. Fixed errors never echo input prose.

The production image is built from `docker/Dockerfile` and published for Linux
amd64 and arm64 at `ghcr.io/dzhng/factory-reviewer`. Factory ships an exact
digest-qualified default. Tags are discovery aids, not executable identities.
The `FACTORY_REVIEWER_IMAGE` test override must contain either a locally verified
image ID or a complete immutable `repository@sha256:…` reference. Factory pulls
a qualified reference, verifies the repository digest Docker observed, and
records the bare digest in the immutable review attempt.

Factory automatically reuses the selected provider CLI's existing login. Native
credential files remain host-owned and are mounted read-only after their owner
and identity are validated. On macOS, where Claude Code owns its login in the
system Keychain, Factory extracts only the `claudeAiOauth` inference identity
into a private `0600` attempt file, mounts it read-only, and deletes it during
normal or crash cleanup. It never exposes unrelated Keychain values such as MCP
OAuth credentials. Factory does not change provider-file permissions, borrow
token environment variables, or persist credentials in portable history. File
identity and a bounded content digest are checked before creation, after
creation, and by the container runner before provider startup.

The selected provider's configuration directory is an empty, bounded tmpfs so
the CLI can create required ephemeral runtime state. The credential is a nested
read-only file mount; the tmpfs has no host source and is destroyed with the
container.

Codex's inner bubblewrap sandbox is disabled inside this container because its
user namespaces are unavailable after capabilities are dropped. The observed
Docker policy is the filesystem sandbox: Codex still sees only the read-only
bundle and credential, ephemeral tmpfs state, and the one writable response
directory.

Reviewer prerequisites are observations, not ambient assumptions. This package
also owns bounded Docker-daemon inspection and exact credential-file readiness.
Review selection and diagnostics consume the same typed result without exposing
credential paths or bytes.

Logical attempts singleflight in private Git-common runtime state. A response is
retained there only while immutable acceptance is pending; successful
publication removes the transient attempt directory because portable review
history then owns durable idempotence. Recovery matches the complete attempt
facts, uses the recorded container name and ownership label, and never cleans an
unproven container.

Completed attempts retain one bounded, canonical prepared publication alongside
private raw output until acceptance succeeds. Preparation is bound to the exact
attempt and bundle under the same lock; replay reuses it without reading a new
secret dictionary. Only genuine repository-issued record capabilities can enter
that freeze; their repository root and exact bytes are bound to the completed
attempt. Review acceptance owns semantic validation and the complete record
graph, while the attempt coordinator owns private durability and verified restore.

Per-attempt lock files live outside disposable attempt directories and remain
after acceptance. Creation, recovery, and deletion use that same stable lock;
queued owners cannot accidentally lock different inodes after cleanup. These
empty private files carry no review or credential state and are not included in
the bounded inventory of active attempts.
