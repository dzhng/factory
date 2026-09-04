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

## Implementation choices — reviewer isolation oracle

### Kill the container, not only the waiting client

- **When:** Slice 02 reviewer-isolation implementation.
- **The choice:** A reviewer starts detached, while Factory waits through a
  separate Docker client process. If a review times out or is cancelled,
  Factory stops waiting and forcibly removes the named container. Docker then
  kills the whole container process namespace, including a child process the
  reviewer started. Merely killing the local `docker wait` command would leave
  that container and its descendants running in the background.
- **The gap:** The spec required timeout, cancellation, descendant cleanup, and
  container removal but did not choose the process-control sequence.
- **The reach:** The production reviewer executor inherits a cleanup path that
  addresses the actual isolation unit. A future engine may replace Docker, but
  it must retain this whole-sandbox cancellation property.
- **Verdict:** Sound. Cleanup is tied to the resource that owns every reviewer
  process rather than to one observer of that resource.
- **Confidence:** High.

### Give the container a small disposable filesystem, not a writable root

- **When:** Slice 02 reviewer-isolation implementation.
- **The choice:** The reviewer runs as numeric user `65532`, with all Linux
  capabilities dropped, a read-only root filesystem, and a 16 MiB temporary
  filesystem at `/tmp`. For example, a CLI may create a Unix socket or scratch
  file in `/tmp`, but it cannot install files into its image or modify mounted
  evidence. The alternative was a writable root filesystem whose mutations
  would disappear later but could hide undeclared reviewer dependencies.
- **The gap:** The plan delegated the base image and disposable cache layout; it
  did not set the container user or initial scratch-space budget.
- **The reach:** Slice 09 can depend on immutable image state and one bounded
  scratch location. The 16 MiB value is an oracle starting point, not a public
  format promise; authenticated provider runs must measure it before release.
- **Verdict:** Sound. It proves the stronger isolation shape while leaving one
  reversible size knob for measured provider needs.
- **Confidence:** Medium.

### Make the build gate produce distributable package output

- **When:** Slice 02 integration on `main`.
- **The choice:** The production package build emits JavaScript and declarations
  under `dist`, while the executable test harness emits a bundled lab. In both,
  `check-types` remains the no-output compiler check. The alternative was to
  call `tsc --noEmit` from both commands, which let type checking pass but left
  Turbo's promised build output empty.
- **The gap:** The workspace bootstrap named separate build and type gates but
  did not state whether library packages should emit artifacts this early.
- **The reach:** Every package added later should keep build output and type-only
  validation as distinct contracts, so release tests can exercise what is
  actually shipped.
- **Verdict:** Sound. A green build now proves an artifact exists instead of
  renaming another check.
- **Confidence:** High.

### Authorize mounts by canonical filesystem identity

- **When:** Slice 02 integration security review.
- **The choice:** Resolve every bind-mount source to its real host path, rerun
  overlap policy on those canonical identities, pass only the canonical paths
  to Docker, and refuse commas that Docker's mount-option grammar can
  reinterpret. Factory creates the stopped container, verifies Docker's
  observed sources, targets, modes, and policy, and only then starts it. The
  alternative was to trust lexically distinct input strings and requested
  arguments, which allowed either a symlink or option injection to change what
  the reviewer could access before a post-start check noticed.
- **The gap:** The planned pure mount API described path overlap but did not say
  whether identity meant spelling or the filesystem object Docker would mount.
- **The reach:** Every future reviewer adapter inherits the same pre-execution
  boundary. Symlinks cannot widen writable authority or disguise auth/bundle
  aliasing, and Docker inspection detects disagreement with the verified plan.
- **Verdict:** Sound. Security follows the resources Docker receives rather than
  user-controlled path notation.
- **Confidence:** High.

### Certify real providers only through the production execution path

- **When:** Slice 02 integration authority review.
- **The choice:** Slice 02 proves the provider-independent isolation boundary
  with an instrumented fake image and records unavailable authorities exactly.
  Authenticated Codex and Claude certification moves to Slice 09, where the
  packaged images and real invocation adapters exist. The alternative was a
  second oracle-only provider launcher that would either be throwaway code or a
  parallel security boundary.
- **The gap:** The original Slice 02 text required real provider execution
  before the production images and invocation seam were scheduled to exist.
- **The reach:** Slice 09 is a release blocker until both current providers run
  with dedicated test credentials on required platforms; unavailable remains a
  typed result and never counts as a pass.
- **Verdict:** Sound. It retains the acceptance authority while ensuring the
  certified path is the one Factory actually ships.
- **Confidence:** High.

## Implementation choices — Slice 01 provider oracle

### Keep generated oracle evidence with the specification

- **When:** Slice 01, provider/reference oracle.
- **The choice:** Running the provider lab writes a human-readable HTML report
  and matching JSON under the Factory v1 spec's assets. For example, a reviewer
  can open the report, follow a fixture link, and compare the claim with the
  exact bytes. The alternative was a generic root output directory whose files
  would have no durable owner and could be mistaken for disposable build output.
- **The gap:** The slice required a browser-playable HTML/JSON artifact but did
  not choose its repository home.
- **The reach:** Future feasibility evidence belongs to the spec it justifies;
  production runtime output must not copy this convention into `.factory`.
- **Verdict:** Sound. The artifact is deliberate review evidence and the spec is
  its natural owner.
- **Confidence:** High.

### Use SQLite only as the concurrency experiment's measuring instrument

- **When:** Slice 01, provider/reference oracle.
- **The choice:** Eight disposable container processes each allocate twenty-five
  rows in one lab-only SQLite table, then the lab verifies the resulting sequence
  is exactly 0 through 199 with no duplicates. This proves that the donor's
  cross-process sequencing test has been reproduced. It does not select SQLite
  for Factory's runtime journal; the alternative was silently allowing the
  feasibility lab to become the production storage decision before the journal
  crash tests exist.
- **The gap:** The slice required concurrent sequencing evidence but deliberately
  left the production journal engine to a later measured decision.
- **The reach:** Slice 04 must rerun the same observable property against its real
  journal seam. No production package imports this lab implementation.
- **Verdict:** Sound. The experiment measures the invariant without pre-deciding
  the production owner.
- **Confidence:** High.

### Treat missing certification as data instead of borrowing a login

- **When:** Slice 01, provider/reference oracle.
- **The choice:** The report distinguishes installed-client versions observed by
  the authority audit from a credential-free Docker certification and from an
  authenticated hook run. Docker could not resolve its image registry, and no
  dedicated test credential was present, so the latter two facts are recorded as
  unavailable. The alternative was to read the developer's working provider
  login or label a host observation as a container pass.
- **The gap:** The plan defined the security boundary and unavailable evidence,
  but the executing environment supplied neither registry access nor test auth.
- **The reach:** Later slices may rely on donor-derived raw-byte behavior, but
  they cannot claim a current live event inventory until the guarded refresh
  succeeds. Reversal is simply rerunning the checked-in probes in a suitable
  environment; successful evidence replaces the unavailable observation in a
  new commit.
- **Verdict:** Sound. It preserves the credential boundary and prevents an
  unavailable check from becoming false confidence.
- **Confidence:** High.

### Keep callback output a donor fixture claim, not a production protocol

- **When:** Slice 01, provider/reference oracle.
- **The choice:** The process lab reproduces the donor's fail-open callback shape:
  both a stored event and an internal capture failure exit zero and emit an empty
  JSON object. Because current authenticated hooks were not run, the report calls
  this fixture behavior rather than asserting that every current provider event
  requires this output. The alternative was to promote one donor wrapper's bytes
  into Factory's hook protocol without current-client evidence.
- **The gap:** The slice asks for provider-valid success and failure output, while
  this environment cannot execute authenticated current hooks.
- **The reach:** The capture vertical must certify its final provider-specific
  output through guarded live tests; until then, only the non-blocking and valid
  JSON properties are inherited.
- **Verdict:** Sound. The evidence remains useful without claiming more authority
  than it has.
- **Confidence:** Medium.
