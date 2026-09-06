# Factory v1 rationale

Factory records the work and decisions behind code without introducing a hosted
account, remote worker, or parallel project hierarchy. Native Codex and Claude
Sessions remain recognizable; their evidence and accepted reviews travel with
the repository in ordinary Git. The [public format](format.md) owns the durable
layout, the [choices ledger](choices.md) records judgment calls, and the
[package map](../../../README.md) leads to the implementation owners.

## Evidence before interpretation

Capture and review are separate commitments. A successful Stop materialization
publishes Session evidence even if no reviewer is available. A review failure
must not erase the work that could explain it. Interrupted materialization can
leave physical prefix files, but only a complete trigger-linked graph enters
the portable projection. The [capture boundary](../../../packages/capture/README.md)
owns graph verification; publication belongs to the
[repository store](../../../packages/repository/README.md).

Provider-native evidence is the common envelope, not a guessed shared event schema.
Stop is an observation boundary, not proof that a provider's transcript has
finished growing. Readable partial evidence remains useful to an LLM, provided
missing, excluded, racing, and corrupt inputs remain explicit. Invalid bytes
must not acquire verified authority because surrounding data is useful.
The [provider oracle](assets/provider-capture-oracle/index.html) is fixture
evidence; the [live capture certificate](assets/live-capture/README.md) separately
identifies authenticated callback observations and their limits.

The private [runtime journal](../../../packages/runtime-journal/README.md)
survives the gap between a hook and portable publication. SQLite owns
transactional ordering and crash-released locks; raw bytes become durable before
rows may reference them. The measured mkdir-lock candidate could strand a lock
after a killed writer, and a timeout or PID guess would not prove safe takeover.
Claims are permanent fences, not stealable leases. Session event positions may
have gaps because other Sessions use the same journal; exact membership, not
global numeric adjacency, establishes a Turn's evidence.

## Branches describe scope, not intent

There is no Epic or inferred workstream. A native Session can span branches and
remain unassociated with any PR. Sessions and exact PR observations relate
many-to-many; branch names, timing, and path overlap cannot prove shared intent.
The [association fold](../../../packages/domain/README.md) produces exact Git
object evidence and preserves manual inclusion as an assertion. Code-state
continuity is a format variant; no continuity inference algorithm ships.

Canonical branch configuration is repository policy, not a live alias for
GitHub's default branch. GitHub can suggest it and report later disagreement;
only an explicit setting changes it. This keeps an external branch rename from
silently changing which decisions need human attention. Missing GitHub must not
disable local capture or workspace review.

## Review authority is frozen and bounded

The [planner and bundle verifier](../../../packages/review-plan/README.md)
separate selection from execution. A frozen bundle contains the exact subject,
evidence ranges, code, limitations, prior ledger, and policy identities needed
to reproduce its inputs without the checkout. Unchanged settled coverage is a
no-op, while incremental review advances Session watermarks and retains the
current PR diff. Partial findings do not silently settle unavailable evidence;
explicit acceptance appends a separate coverage action.

The [security model](../../../SECURITY.md) owns credentials, repository trust,
hooks, Docker, and localhost exposure. Existing provider logins are reused
without a Factory login. Provider-required writable runtime state belongs in
disposable container memory, not a writable host configuration mount. The
[reviewer](../../../packages/reviewer/README.md) observes the actual Docker
boundary and has no host-execution fallback. A requested mount plan alone is
not proof of isolation.

[Review acceptance](../../../packages/review/README.md) validates entries and
citations before publishing semantic history. Model prose is evidence to check,
not authority to choose coverage or overwrite records. Only a bounded semantic
response can become portable review output; operational logs stay private.
Prepared evidence remains plaintext and may contain undetected secrets.
Authentication isolation and best-effort sanitization are not anonymization.

Resource limits bound work, not only retained output. An excluded oversized file
has an unknown content identity; metadata can support a race observation but
cannot justify a fabricated digest or a claim that the worktree is clean.
Descriptor-rooted reconstruction protects against pathname replacement. Native
directory EOF must be carried in the call result, not a later read of mutable
thread-local errno. These constraints and regressions belong to the
[repository boundary](../../../packages/repository/README.md).

## Decision history is not human approval

Canonical scope, analyzer confidence, material change, and human confirmation
are separate facts. The [decision fold](../../../packages/domain/src/decisions.ts)
groups explicit keys instead of inventing semantic similarity. Changed,
removed, or contradictory canonical observations require visible attention;
actions name exact observations and append rather than rewrite. A model may
propose a decision, but v1 actions remain human-only. Resolving a dispute closes
that dispute; it does not implicitly confirm or reject the underlying decision.
The [choices ledger](choices.md) retains these judgments for review.

The [local interface](../../../apps/web/README.md) is a short-lived projection,
not another database or a daemon. Its narrow action seams use the same
validation and compare-and-append authority as other callers, so unseen history
or canonical-branch changes become stale requests rather than silent mutations.

## Distribution and evidence scope

The release boundary certifies exact self-contained executable bytes, not a
source checkout that merely resembles them. The supported native targets are
macOS arm64 and glibc Linux x64-baseline; other targets are not implied by the
reviewer image's architectures. Manifest and executable verification establish
Factory's upgrade authority; GitHub attestations establish separate provenance.
Install, repair, uninstall, and upgrade share one recovery owner, and upgrade
does not migrate repository data. V1 has no donor import or compatibility layer.

The [candidate and publication evidence](assets/final-candidate/README.md)
records exact byte identities, native platform scope, and authenticated provider
journeys. Earlier reports retain their original unavailable authorities: a
later successful run does not retroactively certify them. The
[test harness](../../../packages/test-harness/README.md) owns release-shaped
journeys and the distinction between deterministic fixtures and real providers.

## Visual provenance

The visual standard is readable evidence and honest authority, not a borrowed
product skin. The retained images are browser captures of Factory's generated
reports and deterministic UI fixtures, not user-supplied aesthetic references.

- [Local UI captures and critique](assets/localhost-ui/visual-review.md) record
  the wide/narrow fixture standard: distinguish exact from ambiguous PR evidence,
  partial coverage from completion, and canonical scope from human action.
  The [capture set](assets/localhost-ui/screenshots/) remains the regression reference.
- [Repository workbench critique](assets/repository-workbench/visual-review.md)
  and [accepted screenshot](assets/repository-workbench/screenshot.png) preserve
  the standard of readable paths and distinct invalid-input versus handling outcomes.
- [Live-capture report comparison](assets/live-capture/visual-review.md) retains
  the [before/after set](assets/live-capture/visual/), including mobile table-access
  crops. Those drove fixture-versus-live authority copy and reachable columns,
  not provider-certification claims.
- [Historical release critique](assets/release-certification/visual-review.md)
  retains its [full-page capture](assets/release-certification/screenshot.png).
  Its explicit unavailable authority is the standard; green journey rows alone
  do not mean release certification.
- [Final candidate comparison](assets/final-candidate/visual/README.md) preserves
  the desktop/mobile fixture and authenticated report captures. The comparison
  verifies readable provider authority without retroactively changing the
  pre-publication reports into publication evidence.
- The [journal report critique](assets/journal-crash/visual-review.md) preserves
  an engineering checkpoint with its then-unavailable runtime authority. The
  [roadmap visualization](visualizations/roadmap.html) is historical design
  provenance, not a current build sequence.

The [closeout audit](assets/closeout-audit.md) records the independent claim and
reference checks. All [assets](assets/) remain available, including machine-readable fixtures,
historical review evidence, and reports whose original verdicts are narrower
than the final release. Git history retains the removed implementation ladder.
