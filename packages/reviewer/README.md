# Reviewer boundary

This package owns the security boundary between a verified review bundle and an
ephemeral Docker reviewer. Mount planning is pure and rejects host-path overlap
or provider-auth targets outside the selected provider's namespace. Execution
then observes the container Docker actually created, rather than treating the
requested arguments as proof.

The reviewer package never discovers repository state, provider credentials, or
review subjects. Upstream code supplies already-verified paths; the test harness
owns fake images, live journeys, and human-readable reports.

Bundle verification mints a private capability only for a `ready` plan. The
execution boundary re-verifies that exact digest before using credentials or
starting Docker, so a path or caller-built object cannot authorize a review.
Automatic selection chooses one reviewer from exact attempted Session evidence;
weak context may inform analysis but cannot choose whose harness reviews it.

The host copies and re-verifies the exact declared bundle into a private runtime
snapshot. Docker mounts that snapshot read-only at `/review-input`; the runner
enumerates and hashes it before invoking one provider directly with Factory's
fixed arguments, environment, prompt, and response channel. The provider never
receives the live bundle path, and only its bounded semantic response can cross
back into portable history. Logs and crash coordination remain in the Git-common
private runtime area.

Credentials remain host-owned read-only files. Factory does not copy them,
change their permissions, borrow token environment variables, or translate a
host keyring into the container. A provider whose dedicated file cannot be read
by its validated non-root owner identity is unavailable; changing that boundary
requires an explicit security decision. File identity and a bounded content
digest are checked before creation, after creation, and by the container runner
before provider startup.

Logical attempts singleflight in private Git-common runtime state. A response is
retained there only while immutable acceptance is pending; successful
publication replaces it with a response-free finalized marker. Recovery uses
the recorded container name and ownership label and never cleans an unproven
container.
