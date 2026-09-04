# Coding conventions and best practices

Read the root documentation and any nearer `README.md` before changing a
subsystem. Documentation should explain why boundaries exist and point to the
code that owns their mechanics instead of duplicating inventories that will
drift.

## Security decisions

`SECURITY.md` is the canonical security model. Read it before making or
reviewing decisions about credentials, Git-visible evidence, repository trust,
hooks, Docker mounts, container networking, or the localhost interface.

In particular, do not introduce a Factory-specific trusted-repository registry:
running a checked-out repository is the trust decision. Do not weaken the
boundary between the host and an ephemeral reviewer container.

## Preserve the product model

- A Session is one native coding-harness session; provider identity remains
  visible and lossless.
- Branches are observed Git context, not durable Factory identities or semantic
  work groupings.
- PRs and Sessions have a direct many-to-many relationship through append-only
  association evidence scoped to exact PR observations.
- A review run is immutable and pins the exact subject, evidence watermark,
  code snapshot, and policy versions it used.
- Decisions observed on the configured canonical branch form the canonical
  decision view; changes and confirmations are append-only.
- Raw provider evidence is canonical. Derived projections may be rebuilt but
  may not erase unknown provider fields.

Do not reintroduce automatic Epic or workstream inference. Port existing
semantic contracts only where they preserve the direct relationships and
reproducibility guarantees of the approved local model.

## Keep committed data separate from runtime state

Portable evidence, configuration, association and decision history, and review results belong
under `.factory` and are designed for ordinary Git versioning. Credentials,
locks, caches, live databases, temporary files, and machine-specific paths do
not.

Factory never stages, commits, amends, or changes branches. Preserve unknown
content under `.factory`, including `.factory/skills`; each subsystem may modify
only the paths its format declares that it owns.

## Treat types as documentation

Exported schemas and types are part of the public format. Document why a field
exists, how downstream code interprets it, and what changes when it is set.
Avoid comments that merely restate a type.

Schema evolution must be explicit. A CLI that encounters repository data whose
minimum reader version is newer than itself must stop and ask the user to
upgrade rather than guessing.

## Keep names and abstractions current

- Names describe what code does now, not what an earlier implementation did.
- Remove stale comments, abandoned flags, dead detection logic, and obsolete
  compatibility code when their owner changes.
- Do not preserve shims for unshipped scaffolding.
- Avoid modules that merely re-export another package. A local boundary should
  add project-specific semantics.
- Prefer direct checks for the condition that matters and remove redundant
  fallbacks once an invariant is guaranteed.

Keep comments for non-obvious behavior, platform quirks, invariants, and
downstream consequences—not implementation narration.

## Test through real boundaries

Write tests against observable behavior and stored values, not implementation
details or collection sizes alone. Exercise CLI behavior through the CLI when
possible.

Any test that writes provider configuration, touches a home directory, installs
hooks, creates `.factory` data, or invokes Codex or Claude must run inside the
project's Docker test environment. Never mutate the developer's live Codex or
Claude configuration while testing.

Use mocks only for external service boundaries, and keep them in a dedicated
mock package. The final integration path should exercise real provider CLIs in
Docker with explicitly mounted test credentials.

During implementation, run the narrowest test that answers the current
question. Run the repository-wide build, formatting, linting, and test gates
once as closeout rather than using the slowest gate as the feedback loop.

## Communicate contracts first

The user is technical but does not read every module day to day. Introduce a
component before referring to its internals. When work changes a schema, file
format, CLI contract, or boundary between components, lead with that contract
and its consequences.

## Review before finishing

Check for stale names, stale comments, temporary artifacts, unnecessary
wrappers, duplicated ownership, and redundant guards. The final result should
read as if it were designed for the current local-only product from the start.
