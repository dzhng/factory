# Authenticated capture certificate

Current combined live certification: **unavailable**. A later Claude run failed
authentication, after the retained historical success. The
[current status](status.json) records this boundary without operational logs or
account details. No host login was changed, refreshed, or repaired. Historical
proof remains valid only for the exact images and clients that produced it; it
does not certify a final release candidate or current authentication readiness.

The [Codex](codex-report.json) and [Claude](claude-report.json) reports certify
real lifecycle callbacks from the pinned clients, not fixture playback. Their
matching observation files retain the native identities, immutable Turn
manifests, and callback witnesses used by the assertions. They contain no
transcript text, prompts, credentials, or operational host paths.

Each client completed an initial read-only task, resumed the same native Session
for another task, and completed a third task while Factory refused a deliberately
too-new repository. The first two Stops produced distinct immutable Turns with
readable transcript objects and unchanged raw Stop hashes. Every observed
callback received Factory's empty JSON response and success exit. The refusal
left repository bytes unchanged while the provider still finished its task.
The Factory CLI inside those images was built from committed source `4fba913`;
test-only harness content is pinned by each report's exact image digest.

## Authority boundary

The test-only image derives from the immutable production reviewer image. Its
provider shims delegate version checks to the real pinned clients, but run this
capture journey with hooks and transcript persistence enabled. The built Factory
CLI executes behind a recording wrapper that forwards its exact input, output,
and exit code. These are instrumented installed-hook observations, not a claim
that an uninstrumented release binary was tested here.

The production review attempt coordinator, authentication materializer, Docker
executor, and entrypoint own credential staging, observed read-only mounts,
timeouts, and cleanup. No alternate host token staging exists. The native
repository and provider homes are disposable container filesystems; no live
checkout, provider home, or Docker socket is mounted. Host provider configuration
hashes stayed unchanged, and no attempt-scoped credential staging remained.
The response channel carries an oracle observation, never an accepted semantic
review or decision.

Bundle preparation also runs in a credential-free Docker process, so the
harness does not directly create portable Factory trees on the host. The
production executor still owns its ordinary private immutable input snapshot.

This certificate covers a simple file-read task and resumed text turns. It does
not certify every optional event, compaction, subagents, interactive permission
flows, every platform, or final-process transcript closure. Claude's initial
SessionStart can precede creation of its transcript; the transcript was readable
at Stop and gained later SessionEnd rows. This is compatible with immutable
per-Stop evidence rather than a claim that no later native bytes can appear.

## Reproduction

The journey entry point is
[`run-live-capture.ts`](../../../../../packages/test-harness/src/run-live-capture.ts).
Build the CLI, then build the
[`live-capture` image](../../../../../packages/test-harness/docker/live-capture/Dockerfile)
from the repository root. Pass one provider and that exact local image ID to
the journey. It discovers the existing selected CLI login automatically and
writes private scratch results outside the repository. No setup or token flags
are required. The test-only image must never be published as the reviewer image.

The offline certification test rejects missing Stops, changed raw Stop hashes,
cross-Session callback identities, and failure responses. Its response assertion
was deliberately removed once: the test failed because an invalid response
incorrectly passed; restoring the assertion returned the test to green.

The fixture report's updated authority wording and mobile table access passed
the separate [visual review](visual-review.md). Provider execution and report
presentation remain independent evidence.
