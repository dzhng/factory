# Factory v1 decision ledger

This ledger records why the specification has its current shape. It is not a
second normative schema; the master specification and format own mechanics.

## Product

- Use the name Factory, command `factory`, and repository directory `.factory`.
- Build a local OSS CLI first. Future SaaS ingests the local format rather than
  redefining it.
- Keep the old hosted repository unchanged as a selective donor.
- Use a localhost UI, not a daemon or hosted web product.
- Treat v1 as greenfield. Do not build legacy readers, donor importers,
  compatibility shims, dual writes, or repository-data migrations. A minimum
  reader gate protects data by refusing unsafe reads; it is not a migration
  mechanism.

## Model

- One native provider session is one Session.
- Remove mandatory Epics. Their time/path/worktree heuristics were too brittle
  to represent intent and created a parallel hierarchy beside Git.
- Preserve direct many-to-many Session/PR evidence.
- Treat workspace and PR as review subjects.
- Treat branches as observed navigation context, not immutable identities.
- Use the configured canonical branch to distinguish canonical decisions from
  feature proposals.

## Capture and storage

- Commit complete plaintext evidence on the same branch as code.
- Journal every hook event durably, then materialize immutable chunks at Stop.
- Use per-Stop files to avoid append conflicts.
- Use ordinary Git and content-addressed deduplication; no LFS or pruning.
- Preserve unknown `.factory` contents and never mutate Git state.
- Permit absolute paths inside lossless provider evidence while excluding them
  from Factory-generated portable metadata.

## Review

- Explicit review is the default; automatic review is configurable.
- Advisory exit is the default; `--fail-on` is opt-in enforcement.
- Coalesce pending Stops and review incrementally by evidence watermark.
- Review readable partial bundles rather than missing the review entirely.
- Leave partial triggers unsettled until recovery or explicit acceptance.
- Select PR Sessions only from exact or verified evidence.
- Select workspace evidence inclusively but label weak candidates.
- Use the newest Stop to select the cross-harness reviewer.
- Force-pushes and base changes trigger full current-code review.

## Configuration and installation

- Default to explicit repository initialization.
- Allow global opt-in automatic initialization.
- Let repository config override global schema-defined settings.
- Do not add a Factory trust registry.
- Discover canonical branch with `gh` when available, then commit the confirmed
  value so remote changes cannot silently redefine it.
- Ship global CLI-installed hooks only in v1; plugin detection and distribution
  are deferred entirely.
- Keep the public command surface to `configure`, `init`, `install`,
  `uninstall`, `doctor`, `capture`, `review`, `open`, and `upgrade`. Planning
  probes used during implementation belong to the test harness, not to a
  speculative public `status` or `inspect` namespace.

## Security

- Reuse provider-owned authentication and mount it read-only.
- Give reviewers immutable bundles and one writable output directory.
- Never mount the live checkout or Docker socket.
- Keep Docker network access for the selected model provider.
- Record sanitized immutable failed attempts while keeping transient logs in
  runtime state.
