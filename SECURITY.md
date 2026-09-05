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

Factory does not silently redact, prune, stage, commit, amend, or change
branches. A repository's Git workflow decides what is published and who can
read it. Anyone who can read the Git history may be able to read prompts, tool
inputs and outputs, source snapshots, and other captured evidence. Users must
not put secrets into agent conversations if those secrets cannot enter the
repository history.

Credentials, transient locks, live databases, operational machine-specific
paths, and temporary files never belong in `.factory`. Runtime-only state lives
outside the committed data, under the repository's Git metadata where
practical. Factory-generated portable metadata uses repository-relative paths,
stable IDs, or hashes.

Lossless provider evidence is the deliberate exception to the path rule. A raw
hook payload or transcript may itself contain an absolute path, source fragment,
environment detail, tool output, or secret. Factory preserves those bytes and
does not claim that committed traces are anonymized. Initialization must make
this consequence clear before capture begins.

## Provider authentication stays provider-owned

Factory reuses an authenticated Codex or Claude CLI. It does not collect or
persist provider API keys in Factory configuration.

When a reviewer runs, Factory mounts only the selected provider's required
authentication files into the ephemeral container. These mounts are read-only.
Credentials must never be copied into a container image, review bundle, trace,
generated artifact, log, or committed file.

GitHub observation follows the same ownership rule: Factory invokes an
already-authenticated `gh` executable and never reads, copies, or stores its
token. GitHub is optional; missing or unauthenticated `gh` produces typed
unavailability without disabling local capture or workspace review. Commands
use a fixed argv-only vocabulary with output and time bounds. Successful
selected response bytes may become plaintext repository evidence under
`.factory`, but credentials and transient command error output do not.

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
- writable provider configuration.

The container has network access because the provider CLI must contact its
model service. Review containers are removed after completion; reusable caches,
if introduced, must remain non-authoritative and must not contain credentials or
review evidence.

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

## Upgrades require release authority

Factory replaces its installed executable only from a release artifact whose
trusted manifest digest, archive inventory, target, source identity, and inner
executable digest have all been verified. Release-shaped JSON alone is not
upgrade authority. The staged executable must also run and report the verified
version before it can be promoted.

Install, uninstall, repair, and upgrade share one host-level lock and durable
transaction owner. Recovery may retain the verified old executable or complete
the verified replacement; it must refuse to overwrite bytes that diverged while
Factory was interrupted. Upgrade never grants authority over repository data or
provider configuration beyond reconciling Factory's exactly owned hooks.

CI provenance is a separate authority. Main-branch native candidates receive
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
