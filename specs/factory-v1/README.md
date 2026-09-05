# Factory v1 specification

Status: **implementation review found open behavior gaps; authenticated exact-artifact certification passed; GitHub Release publication pending**

## Next Agent Prompt

Continue from the [implementation review](assets/implementation-review.md).
Acquisition starvation is resolved. Resolve effective reviewer configuration,
automatic review dispatch, and the UI's missing canonical-branch drift observation before
claiming implementation completion. Preserve fail-open capture and the
repository, credential, and container boundaries in [SECURITY.md](../../SECURITY.md).
Use the existing ownership seams and verify each fix through its production
consumer, including repeated reviews when testing forward progress.

The [release report](assets/release-certification/report.json) retains the exact
macOS arm64 artifact at `0f2ba19` that completed both authenticated provider
reviews using the existing local CLI logins without user setup. Its
[visual review](assets/release-certification/visual-review.md) describes the
report's evidence boundaries. Hosted macOS CI remains package-only; GitHub
Release publication and its artifact attestation remain pending. Successful
release journeys do not close the separate behavior findings above.

The ordered [slices](slices/README.md) describe the implementation contracts;
[choices](choices.md) retain rationale and [format](format.md) owns the durable
layout. Git history records completed implementation milestones.

This specification defines Factory's first release: a local CLI that captures
coding-harness Sessions, stores portable evidence with the repository, reviews
exact workspace or pull-request snapshots in ephemeral Docker containers, and
maintains an append-only decision history.

The old `coding-agent-plugin` repository is a reference implementation. Its
provider capture, evidence, analyzer, hook-management, upgrade, and Docker-test
work may be ported when their behavior matches this specification. Its hosted
topology, identities, queues, leases, object transport, remote workers, and
Epic projection are not part of Factory.

## Product promise

> Git records what changed. Factory records the work, evidence, and decisions
> that produced it.

Factory is useful in a repository with no remote, GitHub account, network
service, or pull request. GitHub is an optional source of PR and default-branch
observations, never a prerequisite for capture or workspace review.

## Vocabulary

- **Session:** one native Codex or Claude Code session. Provider identity is
  preserved without translation.
- **Turn:** the immutable evidence materialized for one provider `Stop`.
- **Trigger:** an append-only request for review created for every `Stop`.
- **Workspace review:** a review of an exact local worktree snapshot, normally
  associated with the currently checked-out branch but also valid at detached
  HEAD.
- **PR observation:** an immutable observation of a pull request at one exact
  base, head, and provider update.
- **Association:** evidence that one Session contributed to one exact PR
  observation.
- **Review run:** one immutable reviewer execution over a frozen bundle.
- **Decision:** an analyzer observation about an architectural or behavioral
  choice. Decisions observed on the configured canonical branch form the
  canonical decision view; changes never overwrite prior observations.

There is no mandatory Epic, task, or inferred workstream record in v1. Branch
names, timing, path overlap, and worktree identity are observations—not proof
that Sessions share intent.

## Sacred contracts

1. Factory never stages, commits, amends, checks out, creates, deletes, or
   changes branches.
2. Provider-native evidence is canonical and lossless. Derived projections may
   be rebuilt but may not erase fields Factory does not understand.
3. Every useful hook event is durably journaled before its hook returns. Hook
   failures are visible but never strand the provider Session.
4. Every `Stop` attempts to atomically materialize one immutable Turn, code
   observation, and review trigger into `.factory`.
5. Review and capture are independent. Failed or absent reviews never delay or
   remove captured Session evidence.
6. Sessions and PRs are many-to-many through evidence scoped to exact PR
   observations. Weak heuristics never become associations silently.
7. Review bundles pin exact subjects, triggers, Session watermarks, code,
   changes, observations, prior ledger, limitations, object inventory, and
   analyzer/prompt/policy/format versions.
8. Readable partial evidence receives a clearly partial review. Missing or
   corrupt material is never represented as complete or passed as verified.
9. Review and decision history is append-only. Corrections supersede, resolve,
   confirm, or dispute prior records instead of rewriting them.
10. Reviewers run in ephemeral Docker containers with immutable input, one
    writable output directory, provider-owned authentication mounted read-only,
    and no live checkout or Docker socket.
11. `.factory` is an open namespace. Factory modifies only paths declared in
    the [format specification](format.md) and preserves unknown content,
    especially `.factory/skills`.
12. An older CLI stops before mutation when repository data requires a newer
    reader.

## System flow

```text
Codex / Claude hooks
        |
        v
.git/factory-runtime journal -- Stop --> immutable .factory Turn + trigger
                                                |
                                                v
                                     factory review [--pr N]
                                                |
                         frozen read-only bundle + provider auth (read-only)
                                                |
                                                v
                                  ephemeral Docker reviewer
                                                |
                                                v
                                  immutable review + decision records
```

The runtime journal is recoverable machine state, not canonical history. Once
a Turn has been verified in `.factory`, its redundant runtime bytes may be
reclaimed. A later hook, `doctor`, or `review` resumes interrupted
materialization.

Session evidence enters `.factory` when Stop materialization succeeds, not when
a review succeeds. Reviews are downstream and independent. If `.factory` has an
unresolved Git conflict, materialization pauses while the runtime journal keeps
accepting events; Factory neither resolves nor stages the conflict.

## Repository and Session ownership

The first initialized Git repository observed for a native Session owns that
Session. Subsequent activity in another repository remains visible in raw
evidence but does not change ownership or cause Factory to copy the other
repository's code. The Turn records a cross-repository limitation.

Within one repository, a Session may observe several branch names or detached
states. These observations do not split the native Session. Immutable Turn
chunks allow ordinary Git merges to remain additive even when a Session
continues after earlier evidence was committed.

## Configuration

Effective configuration uses this precedence:

```text
command flags
-> repository .factory/config.json
-> global Factory config
-> built-in defaults
```

Global configuration is stored at `$XDG_CONFIG_HOME/factory/config.json`, with
`~/.config/factory/config.json` as the fallback. It contains user preferences,
including repository initialization, default reviewer, automatic review,
Docker limits, update checks, and an optional canonical-branch fallback.

Repository configuration is committed and may override every schema-defined
setting. It contains project policy such as canonical branch, reviewer,
automatic review, decision policy, and review thresholds. It may not add
arbitrary commands or host mounts.

`repositoryInitialization` defaults to `explicit`. A user may select
`automatic` globally, authorizing hooks to initialize `.factory` on first use
inside an otherwise uninitialized Git repository. Configuration must show the
plaintext-evidence warning before enabling that global opt-in.

### Canonical branch

`factory init` and repository-scoped `factory configure` suggest a canonical
branch using, in order:

1. `gh repo view --json defaultBranchRef` when an authenticated `gh` is
   available;
2. a local remote-HEAD symbolic ref;
3. an existing `main` or `master` branch; or
4. an explicit user value.

The confirmed value is written to `.factory/config.json`. GitHub does not
silently redefine it later. `doctor` and the UI report disagreement between the
committed setting and a later GitHub observation.

## Command contract

### `factory configure`

Edits global preferences with `--global` and committed repository settings
with `--repo`. It prints the target file and resulting effective configuration.
Repository mode can discover, confirm, or override the canonical branch.

### `factory init`

Creates only Factory-owned `.factory` paths, preserves unknown content, warns
that complete traces can contain source, paths, tool output, and secrets, and
configures the canonical branch. Re-running it is idempotent.

### `factory install` / `factory uninstall`

Installs or removes Factory-owned user-level Codex and Claude hooks. Hooks call
the verified global `factory` executable. Installation preserves unknown
provider configuration and records fingerprints for only the entries Factory
owns. Provider plugins and plugin detection are outside v1.

### `factory doctor`

Inspects configuration, hooks, runtime recovery, `.factory` validity, reader
version requirements, Docker, provider authentication, `gh`, canonical-branch drift,
and storage usage. Mutation requires an explicit repair action; diagnostic mode
is read-only.

### `factory capture`

Is the narrow hook-facing adapter. It accepts provider lifecycle bytes,
durably journals them, materializes at `Stop`, emits provider-valid responses,
and never launches a reviewer synchronously. Outside an initialized repository
it is a no-op unless global automatic initialization is enabled.

### `factory review`

With no PR subject, reviews the current workspace. It selects unreviewed Stops
with verified state continuity and includes weak same-branch candidates as
labeled context. `--session` narrows this set.

`--pr <number>` observes that exact PR with `gh`, selects only exact or verified
Session associations, and reviews the complete current PR diff. Unchanged,
fully covered subjects produce an `already reviewed` result without Docker.

Reviews are advisory by default. `--fail-on <severity>` turns findings at or
above a threshold into a nonzero exit. Execution or validation failure is
always nonzero. `--full` or `--force` explicitly reanalyzes prior evidence.
`--accept-partial <review-id>` records that permanently unavailable evidence is
accepted for coverage without rewriting the partial review or its triggers.

### `factory associate`

`factory associate --pr <number> --session <key> --actor <name> --reason <text>`
adds an explicit Session-to-PR assertion. It first observes the exact PR, then
stores the actor and reason in append-only manual association evidence. Manual
evidence is labeled asserted, never machine-verified. Later observations of the
same PR carry the completed assertion forward with its original actor, reason,
and action time so a subsequent review can consume it.

### `factory open`

Starts a short-lived server bound to `127.0.0.1`, opens the repository UI, and
stops with the CLI. It is not a daemon and never binds publicly by default.

### `factory upgrade`

Performs the only CLI update mutation. It verifies the target package and
replacement executable, protects global configuration with an external lock
and durable replacement journal, reconciles owned hooks, and either completes
or reports a provable rollback/manual-recovery state. It never rewrites
repository data. V1 has no legacy import, compatibility, dual-write, or data
migration path. Startup update checks only display cached warnings.

## Association rules

A Session is automatically associated with a PR observation only when Factory
has:

- an exact observed commit or head SHA contained in that PR; or
- verified code-state continuity showing that the Session's captured work was
  preserved into a matching commit.

Same branch, nearby time, same worktree, or overlapping paths are candidate
signals only. Manual inclusion creates append-only association evidence. A
force-push or base change creates a new PR observation; prior associations stay
historical. Divergent ancestry forces a full current-code review.

A Session may have no PR association. Such an orphan is still ordinary captured
evidence and may participate in workspace review; Factory does not invent a PR,
Epic, or branch identity to place it.

## Review generation and coverage

Reviews are explicit by default. Automatic review is an optional configured
policy that consumes the same durable triggers; hooks never wait for it.

Pending Stops for one selected workspace or PR coalesce into one review through
the newest selected watermark. The review records every trigger it covers.

Coverage identity includes:

- subject and exact workspace/PR observation;
- per-Session evidence watermarks;
- code manifest and staged/unstaged or PR diff objects; and
- analyzer, prompt, policy, and format digests.

The review manifest additionally records the immutable container-image digest,
provider CLI version, selected model and effort, effective reviewer settings,
and host platform. These facts explain an execution but do not make host paths
part of the portable format.

An incremental PR review includes new Session evidence and the complete current
PR diff. Previously covered evidence is represented by its prior canonical
ledger. Continuing Sessions resume after their prior watermarks.

A partial review records findings but does not fully discharge its triggers.
Recovered evidence can be reviewed later with the partial ledger as context.
Permanently unavailable evidence requires an explicit acceptance record before
coverage becomes settled.

`reviewer: auto` uses the newest covered Stop's provider as the authoring
reference, prefers the other authenticated harness, and falls back to a fresh
isolated Session of the same harness. Mixed-provider work does not implicitly
run two reviewers. If Docker or the required isolation boundary is unavailable,
the review fails visibly; Factory never falls back to running the reviewer on
the host.

## Decision model

The analyzer emits decisions, assumptions, risks, validations, and code
findings with exact evidence citations. Invalid or uncited model output remains
execution evidence but does not enter the semantic ledger.

Feature-branch and PR reviews produce proposed decisions. Decisions extracted
from exact snapshots of the configured canonical branch form the canonical
view. A material change, removal, or contradiction creates a high-priority
pending supersession. It never silently overwrites a prior decision.

Confirmation, rejection, dispute, and supersession are append-only actions.
Canonical scope and human confirmation are separate facts: a reviewer can
observe a canonical-branch decision without claiming that a human approved it.

## Package architecture

Factory is a Bun/Turborepo monorepo targeting Node.js 22 or newer:

```text
packages/
  contract/       public schemas, IDs, version gates, owned-path types
  repository/     sole .factory writer, CAS, safe Git observation/reconstruction
  runtime-journal/private Git-common capture journal and recovery authority
  capture/        Codex/Claude adapters and Turn materialization
  github/         optional gh boundary, PR observations and exact artifacts
  domain/         pure association, coverage, decision, and UI projections
  review/         planning, bundles, validation, immutable review acceptance
  reviewer/       typed Docker mount plans, provider execution and cleanup
  cli/            sole `factory` executable and command orchestration
  mocks/          test-only external boundary doubles
  test-harness/   Docker matrices, crash labs, live guarded journeys
apps/
  web/            localhost UI projection and decision confirmation
```

Packages must add ownership or project semantics; no package may exist merely
to re-export another. The committed format belongs to `contract` and is written
only through `repository`; it never belongs to the UI or CLI presentation
layer. Only `repository` may write `.factory`. Only `runtime-journal` may write
the runtime journal; `capture` consumes that authority. Only `reviewer` may
construct Docker invocations. Provider
processes and `gh` are invoked through typed adapters, never shell strings.
`capture` owns provider-specific hook patch plans; `cli` applies those plans.
`domain` only folds records; `review` validates action requests and asks
`repository` to append them.

The seam-heavy draft proposed nineteen packages; the fewest-slices draft
proposed five feature-sized passes. This plan keeps the valuable invariant
chokepoints without turning every internal module into a workspace. Pure
planner/executor boundaries remain inside their owning packages.

## Testing boundary

Pure reducers, encoders, verifiers, and reconstruction run as ordinary unit
tests. Any test that writes provider configuration, touches a home directory,
installs hooks, creates `.factory`, invokes provider CLIs, supplies credentials,
or executes reviewers runs inside the project Docker test environment.

The test harness owns:

- byte-for-byte provider fixtures and unavailable-field inventories;
- crash injection at every journal, object, manifest, and promotion boundary;
- concurrent-hook and lock contention tests;
- Git branches, worktrees, force-pushes, merge conflicts, and path edge cases;
- partial/corrupt bundle verification;
- deterministic fake analyzer and provider boundaries;
- authenticated real Codex and Claude journeys when their existing CLI logins
  are discovered automatically and exposed through bounded read-only mounts;
  and
- host sentinels proving real provider configuration and the live checkout were
  not changed.

Mocks exist only for external services and provider processes. The final local
journey exercises the release-shaped global CLI, direct hooks, an initialized
Git repository, Docker review, incremental coverage, canonical decisions, and
localhost UI without GitHub.

## Versioning and evolution

Every public immutable record declares `schemaVersion`. Mutable
`.factory/config.json` is the deliberate exception: its schema is selected by
the root manifest and unknown fields survive read-modify-write.
`.factory/manifest.json` declares the repository format and
`minimumReaderVersion`. Readers preserve unknown Factory namespace content and
unknown provider evidence.

A CLI reads only enough of the root manifest to compare its version. If the
minimum reader exceeds it, the CLI stops before mutation and requests an upgrade.
V1 is a hard cutover: it ships no older-schema reader, donor importer,
compatibility shim, dual writer, or repository-data migration framework.

## Research and replication baseline

The donor is evidence, not architecture. Before translation, Slice 01 must
reproduce its relevant behavior and recertify assumptions against current
clients.

Measured donor anchors:

- `packages/capture` has 28 non-test TypeScript files and seven test files;
  its tests cover transcript replacement and truncation, Stop lag, concurrent
  sequencing, CAS-before-record durability, disk failure, hostile Git filters,
  paths, worktrees, and races.
- `packages/evidence/src/code-manifest.ts` contains selectively portable
  exact-byte path, traversal, link, digest, reconstruction, and atomic-promotion
  behavior.
- The provider fixture corpus contains Codex and Claude hook/transcript streams.
  Event inventories and unknown-field round trips are reusable tests, but
  current provider CLIs remain the oracle.
- `packages/review-runner` contains useful invocation, output-validation, and
  process-cleanup behavior but is fused to resident VM/transport machinery that
  must not be ported.
- `packages/backend/src/projection/reducer.ts` is a negative reference: its
  time/branch/worktree Epic inference is forbidden.
- Duet confirms Node 22, Bun/Turborepo, strict TypeScript, per-workspace docs,
  and narrow-before-global verification conventions.

External boundaries follow the documented behavior of Git common-directory
discovery, Docker read-only bind mounts and tmpfs, and `gh repo view` default
branch discovery. Slice 01 records exact tool/client versions so later slices
do not encode folklore.

## Implementation roadmap

Implementation follows the individual files in [`slices/`](slices/). The
[roadmap visualization](visualizations/roadmap.html) shows dependencies and
review gates. Slices 01 and 02 are feasibility passes; failure reslices the
affected provider boundary before the public format is frozen.

```text
01 provider/reference oracle ─┬─> 03 public format and repository store
02 Docker auth/isolation ─────┘                |
                                               v
04 runtime journal -> 05 Git observation -> 06 capture vertical
                                               |
                                               v
07 PR observations -> 08 review plan/bundle -> 09 review execution
                                               |
                                               v
10 decisions -> 11 localhost UI -> 12 release/install/upgrade proof
```

Each slice ends in an observable artifact and its narrowest real-boundary test.
Repository-wide build, formatting, lint, test, and release journeys run once
near closeout.

## Standing review map

- Every slice: review the named artifact against its contract, run the narrow
  seam tests, then audit stale names/comments, duplicated ownership, wrappers,
  and temporary scaffolding before landing it.
- Security-sensitive slices: re-read `SECURITY.md`; update it in the same slice
  if credentials, mounts, networking, hooks, evidence visibility, repository
  trust, or localhost exposure changes.
- Any screenshot-producing slice: the final visual check is an unprimed
  `screenshot-critique`. When a prior or reference image exists, also run
  `compare-screenshots`. Open accepted candidates with `preview-shots`, allow
  roughly five minutes for human feedback, record the evidence-based choice,
  close the shots, and continue if the user is silent.
- After each completed substantive slice: run the project `code-review` pass.
  Before declaring the whole feature done, run the full `review` closeout.

## Fog-of-war reslicing rules

Do not absorb these failures as implementation detail:

- If current Codex and Claude hooks do not share durable Session/Stop semantics,
  split provider capture before defining common parsed fields.
- If a reviewer needs writable provider state, separate immutable source auth
  from a disposable derived overlay and update the security decision before
  proceeding; never make provider credentials writable.
- If Stop routinely precedes final transcript bytes, add a bounded later-
  observation protocol rather than claiming the Turn is complete.
- Start PR association with exact commit/head evidence. Enable
  `code-state-continuity` only after a false-positive-heavy corpus proves a
  deterministic algorithm; otherwise keep it unavailable in v1.
- If readable partial, unsafe, corrupt, and deliberately excluded inputs cannot
  be classified deterministically, split completeness classification out of
  bundling.
- If semantic decision identity is unstable, require explicit deterministic
  keys or human linking; do not hide fuzzy grouping in a reducer.
- If one UI screenshot exposes several unresolved information-hierarchy
  variables, split the UI slice into overview, evidence, and action passes.

## Scope firewalls

Do not add hosted services, accounts, remote workers, persistent VMs, Epic or
workstream inference, a Factory trust registry, provider plugins, writable auth,
checkout or Docker-socket mounts, Git mutation, LFS, silent pruning, secret
redaction claims, Windows support, a resident daemon, legacy imports,
compatibility shims, dual writes, or repository-data migrations.
