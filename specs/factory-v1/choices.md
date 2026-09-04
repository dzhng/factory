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

## Implementation choices — workspace bootstrap

### Pin the initial toolchain exactly

- **When:** Workspace bootstrap before Slices 01 and 02.
- **The choice:** Factory pins Bun 1.3.14, Turborepo 2.10.3, TypeScript 5.9.2,
  oxfmt 0.57.0, and oxlint 1.72.0. A fresh clone therefore installs the same
  tools that produced the checked-in lockfile instead of silently receiving a
  newer compiler or formatter with different output.
- **The gap:** The spec fixed Node 22, Bun, and Turborepo but did not fix every
  development-tool version.
- **The reach:** Every workspace inherits these parser, type-checking, task, and
  formatting semantics until an explicit dependency update changes them.
- **Verdict:** Sound. Exact tools make the replication labs reproducible and
  match the proven donor/conventions baseline.
- **Confidence:** High.

### Keep shared TypeScript policy at the repository root

- **When:** Workspace bootstrap before Slices 01 and 02.
- **The choice:** Packages extend one root `tsconfig.json`. The alternative was
  a `typescript-config` workspace whose only job would be to re-export compiler
  settings. Browser or other genuinely different environments may add a narrow
  child config when they arrive.
- **The gap:** The spec required strict shared TypeScript configuration but did
  not choose whether that configuration was a package.
- **The reach:** New packages have one default type policy without adding a
  dependency or a package that owns no runtime/project semantics.
- **Verdict:** Sound. It preserves one owner and avoids an empty abstraction.
- **Confidence:** Medium.

### Do not auto-format prose with the source-code gate

- **When:** Workspace bootstrap before Slices 01 and 02.
- **The choice:** The root formatter checks source and structured configuration,
  while Markdown remains a reviewed documentation surface. The alternative was
  to reflow specs and project skills whenever source formatting ran, creating
  unrelated documentation churn in implementation commits.
- **The gap:** The spec required formatting gates but did not define whether
  prose belonged to the automatic source formatter.
- **The reach:** Source passes stay focused; documentation correctness is checked
  by the write-docs/link review rather than formatter output.
- **Verdict:** Sound. It keeps commits attributable without weakening source
  formatting.
- **Confidence:** Medium.
