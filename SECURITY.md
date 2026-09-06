# Security model

Factory is a local, open-source CLI. It has no Factory account, hosted control
plane, or remote evidence store. Its meaningful boundaries are the Git
repository, the host machine, and the ephemeral reviewer container.

## A repository is one trust domain

Checking out a repository and running its code already grants that repository a
meaningful place on the developer's machine. Factory does not add a separate
trusted-repository registry or confirmation ceremony.

Repository settings in `.factory/config.json` override global Factory defaults.
Those settings may select any option supported by Factory's schema, but they do
not create arbitrary host mounts or new command-execution mechanisms.

This is a deliberate simplicity boundary. Do not add a second trust system that
pretends to protect a developer from a repository they have chosen to execute.

## Committed evidence is plaintext

`.factory` is part of the repository and is intended to be committed on the same
branch as the code. Session events, transcripts, review inputs, and review
outputs are stored as inspectable plaintext or content-addressed objects.

Factory does not stage, commit, amend, or change branches. A repository's Git
workflow decides what is published and who can
read it. Anyone who can read the Git history may be able to read prompts, tool
inputs and outputs, source snapshots, and other captured evidence. Users must
not put secrets into agent conversations if those secrets cannot enter the
repository history.

Source snapshots are prepared using the shared evidence-sanitization policy
before entering the object store. It discovers repository env assignments
without executing files or following symlinks and redacts known values and
recognizable credentials. Env source files, unsupported binary data, sensitive
paths and unsafe symlink targets are omitted. These are UTF-8 review snapshots,
not promises of executable or byte-identical source. Original Git race state
remains separate from sanitized object identity. Discovery or preparation failure
does not authorize raw source publication. Detection remains best effort, not an
anonymization guarantee. Provider capture uses the same policy before portable
publication; reviewer output remains a separate boundary being converted by the
active sanitization plan.

Credentials, transient locks, live databases, operational machine-specific
paths, and temporary files never belong in `.factory`. Runtime-only state lives
outside the committed data, under the repository's Git metadata where
practical. Factory-generated portable metadata uses repository-relative paths,
stable IDs, or hashes.

Provider evidence can still contain absolute paths, source fragments and other
environment detail. Exact originals remain in the private journal and provider
home. Portable hook/transcript evidence is redacted before hashing and recognized
tool results are shortened. Frozen private preparation makes crash recovery reuse
the same safe bytes rather than rediscovering an altered env dictionary. This is
best-effort credential removal, not a claim that committed traces are anonymized.

## Provider authentication stays provider-owned

Factory reuses an authenticated Codex or Claude CLI without a separate Factory
login or credential setup. It discovers each CLI's conventional provider-owned
authentication location; explicit paths exist only for nonstandard installations
and controlled tests. Factory does not persist provider API keys in its
configuration.

On macOS, Claude Code stores its login in the system Keychain instead of its
configuration directory. Factory asks macOS for Claude Code's provider-owned
credential at review time, extracts only the `claudeAiOauth` inference identity,
and writes that minimal value to a private `0600` file under the review attempt's
runtime directory. Unrelated values in the Keychain record, including MCP OAuth
credentials, do not cross the reviewer boundary. The staged file is deleted with
the attempt during normal completion or crash recovery; it never enters
`.factory`, a review bundle, an image, or a log.

The release harness keeps the same ownership even though its disposable home is
not the user's home. It gives the packaged CLI the absolute path of the user's
validated login Keychain database, so the packaged CLI performs extraction only
inside its crash-recoverable review attempt. The harness never stages an OAuth
token in its broader release scratch directory.

When a reviewer runs, Factory mounts only the selected provider's required
authentication file into the ephemeral container. The mount is read-only.
Credentials must never be copied into a container image, review bundle, trace,
generated artifact, log, or committed file.

The selected provider receives a small writable tmpfs configuration home because
provider CLIs create ephemeral runtime state even when persistence is disabled.
That tmpfs has no host source and disappears with the container; the nested
credential-file mount remains read-only. No other provider home or host
configuration is mounted.

The Docker boundary, not a provider CLI's nested process sandbox, owns filesystem
confinement. Codex therefore runs without its inner bubblewrap sandbox: user
namespaces are unavailable inside the capability-free container, and enabling
them would not add authority beyond the container. The read-only root and bundle,
read-only credential, fixed non-root user, dropped capabilities, and observed
mount allowlist remain mandatory before provider startup.

GitHub observation follows the same ownership rule: Factory invokes an
already-authenticated `gh` executable and never reads, copies, or stores its
token. GitHub is optional; missing or unauthenticated `gh` produces typed
unavailability without disabling local capture or workspace review. Commands
use a fixed argv-only vocabulary with output and time bounds. Selected response
text is sanitized before its content references exist. Source-like patch
sections for env files, binary payloads, or unsafe/sensitive paths are omitted,
including quoted paths in Git patch headers and preambles. Operational
repository locators must remain unchanged, while only schema-validated Git
object fields retain structural SHA authority. The complete safe acquisition
is prepared before publication; sanitizer failures publish no prefix. Stored
evidence remains plaintext, and credentials and transient command error output
do not belong in it. Detection remains best effort under the shared policy.

Read-only mounting limits accidental mutation; it does not stop software in the
container from reading a credential. The reviewer container and the selected
provider CLI therefore form one trust domain for the duration of the review.
For a private provider-owned file, the container runs as that file's validated
non-root numeric owner UID with a fixed unprivileged group; Factory refuses
root-owned or foreign-owned auth rather than copying the file or changing its
permissions. Publicly readable test credentials may use the fixed unprivileged
test identity.

Production reviewer tags are only a publication and discovery mechanism.
Factory refuses to execute a mutable tag: configuration must select an exact
digest-qualified image reference, Docker must observe that repository digest
after acquisition, and the immutable review attempt records the selected
digest. Changing a tag therefore cannot change an already selected review
environment.

## The reviewer container is isolated from the live checkout

A review receives an immutable snapshot of its exact code and evidence, mounted
read-only, plus one writable output directory. The container must not receive:

- the live working tree;
- the Docker socket;
- unrelated host directories or credentials; or
- a writable host-backed provider configuration.

The container has network access because the provider CLI must contact its
model service. Review containers are removed after completion; reusable caches,
if introduced, must remain non-authoritative and must not contain credentials or
review evidence.

CPU, memory, process-count, and execution-time ceilings are configurable within
bounded schema ranges. Docker must report the selected CPU, memory, process,
and no-extra-swap ceilings before the provider starts. These preferences cannot
relax the fixed mount, identity, capability, filesystem, or network policy.

The review bundle is the security and reproducibility boundary. It pins the
workspace or PR subject, Session evidence watermarks and associations, code
snapshot, change set, PR and canonical-branch observations, review-policy
versions, prior ledger, and known limitations. The reviewer must not reach
outside that bundle for repository state.

## Hooks are narrow capture adapters

Global Factory hooks receive provider lifecycle events and pass them to the
installed `factory` executable. Hook installation must preserve unknown
provider configuration and avoid duplicate Factory hooks. Hooks may initialize
a repository only when the user's global initialization setting allows it.

Hook failures must remain non-blocking to the coding harness. Failure to record
evidence should be visible through Factory diagnostics, but it must not strand
or corrupt the user's Codex or Claude session.

When effective configuration enables automatic review, capture may relaunch
the installed Factory executable in the background to review durable triggers.
It uses the same credential and container boundaries as a manual review, not
repository-supplied host commands. The hook does not wait for model execution;
failures remain in review evidence or private diagnostics.

## Upgrades require release authority

The npm distribution packages verified native release bytes inside
`@dzhng/factory`. npm's registry integrity and publishing credentials authorize
package installation; Factory does not claim its archive manifest independently
authenticates an npm publisher. Packaging binds both binaries to the tag's exact
source and version. No npm lifecycle script changes provider settings or fetches
executables. The launcher selects a bundled binary; hook installation remains
explicit. Global npm installations update through npm, with lifecycle scripts
disabled and the destination prefix derived from the running executable, never
from npm's default prefix. Project-local installs and other package managers are
not automatically modified.

Only an explicit upgrade installs a newer version. npm installation is serialized
with Factory's install lock and refused while a native transaction is pending.
npm owns package replacement and recovery, not Factory's native transaction
journal. Its package replacement is not atomic across concurrent command or hook
launches, and the install lock does not protect those launches. A running native
process retains its loaded version. npm upgrades neither reconcile hooks nor
change repository data.

Update discovery is separate from upgrade authority. Interactive commands may
show private, expiring observations and start a detached metadata-only checker.
The checker contacts the fixed public npm registry or `dzhng/factory` GitHub
release endpoint, without authentication or redirects, with time and size bounds.
It serializes checks and records attempts before network I/O so failures and
crashes do not retry on every command. Foreground commands never wait for network
discovery. Pipes, capture hooks, and automatic-review workers neither check nor
display notices. Repository and global preferences can disable checks and notices;
explicit upgrades remain available. A cache entry cannot authorize executable
replacement. User controls live in the [installation guide](scripts/npm-README.md).

For standalone upgrades, Factory replaces its installed executable only from a release artifact whose
trusted manifest digest, archive inventory, target, source identity, and inner
executable digest have all been verified. Release-shaped JSON alone is not
upgrade authority. The staged executable must also run and report the verified
version before it can be promoted.

Install, uninstall, repair, and upgrades share one host-level lock. Native
mutations also share a durable transaction owner. Recovery may retain the verified old executable or complete
the verified replacement; it must refuse to overwrite bytes that diverged while
Factory was interrupted. Upgrade never grants authority over repository data or
provider configuration beyond reconciling Factory's exactly owned hooks.

CI provenance is a separate authority. Main-branch and release-tag native candidates receive
GitHub artifact attestations, but an attestation does not replace Factory's
manifest, archive, target, and executable verification. Pull-request workflows
remain read-only and cannot mint repository attestations.

## The local web interface is local

`factory open` starts a short-lived server bound to `127.0.0.1`. It is a view
over repository data, not a daemon or a remote service. Its only repository
mutations are schema-validated append-only user actions, such as confirming a
decision. Do not bind it to a public interface by default, and do not treat the
lack of application login as permission to expose it to a network.

## Security changes update this document

Changes to repository trust, credential handling, host mounts, container
networking, trace visibility, hook execution, or localhost exposure are changes
to the security model. Update this file in the same change rather than hiding a
new boundary in implementation details.
