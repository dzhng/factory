# 12 — Installation, diagnostics, upgrade, and release proof

Status: **implementation completion in progress; release acceptance not granted**

## Resolved release scope

V1 ships self-contained Bun executables as immutable GitHub Release assets.
The required release matrix is macOS arm64 and glibc Linux x64-baseline. Linux
arm64, macOS x64, musl Linux, and Windows are not claimed by v1. Each executable has
one adjacent manifest with its SHA-256 digest, byte length, version, source
revision, target, and SBOM/license inventory. Certification consumes the exact
binary later published; it never rebuilds a lookalike for a test.

Factory is MIT licensed. GitHub's release transport and artifact attestation
provide distribution provenance; Factory's own upgrade boundary additionally
requires the exact manifest digest before it mints a `VerifiedRelease`.

## Implementation passes

1. Build self-contained target executables with embedded release identity and
   emit bounded manifests from an allowlisted release builder.
2. Extract installation inspection and pure diagnostics from CLI orchestration;
   move read-only runtime and GitHub probes behind their owning packages.
3. Replace the hook-only transaction with one typed installation transaction,
   then add verified, crash-safe executable upgrade and recovery.
4. Certify the packed artifact through the clean install/capture/review/action/
   UI/diagnose/uninstall journey and emit sanitized JSON/HTML evidence.
5. Add the native CI matrix, record unavailable external authorities honestly,
   and run the one-time whole-product review and release audit.

## Contract

One exact release artifact works on supported macOS and Linux: configure,
initialize, install/reconcile both providers' direct hooks, capture immutable
Turns, review a workspace, optionally review a PR, confirm a decision, open the
UI, diagnose failures, uninstall owned hooks, and upgrade the executable.
Upgrade is crash-safe for executable/global-config/hook replacement and never
rewrites repository data. There are no legacy readers, donor imports,
compatibility shims, dual writes, or migrations.

## API seam

```ts
inspectInstallation(): Promise<InstallationStatus>;
planHookReconciliation(status: InstallationStatus): HookPlan;
runDiagnostics(context: DiagnosticContext): readonly Diagnostic[];
planUpgrade(target: VerifiedRelease): UpgradePlan;
executeUpgrade(plan: UpgradePlan): Promise<UpgradeResult>;
certifyRelease(artifact: ReleaseArtifact): Promise<CertificationReport>;
```

Diagnostic mode is read-only. Repairs are explicit typed actions. The release
harness owns certification and introduces no new product authority.

## Runnable artifact

`bun run release:verify` either packs a clean committed checkout or accepts an
already packed candidate, verifies and installs those exact bytes, runs the full
journey on a native host with Docker, and emits a sanitized HTML/JSON report
with artifact digest, platform/architecture, Node/Bun/Git/Docker/provider
versions, journey verdicts, and unavailable optional authority. Hosted Linux
provides complete journey authority. Hosted macOS verifies the native package
but records its unavailable Docker reviewer authority; a local native macOS
arm64 run proves the complete deterministic fixture journey.

## Verification

- Test the packed artifact, not workspace source; verify license/SBOM/package
  content contains no credentials, caches, donor names, hosted endpoints,
  control-plane code, or unexpected executables.
- Cover missing/stale/edited/duplicate hooks, executable relocation, provider
  absence, Docker/auth/`gh` diagnostics, canonical-branch drift, recovery, and
  storage reporting entirely in Docker where required by `AGENTS.md`.
- Crash executable replacement and hook reconciliation at every journal
  boundary; end with either verified old or verified new installation and exact
  manual recovery instructions.
- Too-new repository data refuses before mutation and asks for a newer CLI; no
  code attempts to transform it.
- Run macOS/Linux and chosen architecture/provider matrices. Missing required
  real certification is an objective blocker, never a mocked pass.
- Close out once: format, lint, types, unit, Docker integration, crash labs,
  provider journeys, UI visual gate, packaged smoke, stale-name/comment and
  duplicate-ownership audit, then full `review`.

## Delegated decisions

CI partitioning, cache mechanics, report layout, progress copy, and recovery
journal encoding. Distribution channel and architecture matrix must be chosen
before implementation; platform promise, greenfield cutover, evidence
preservation, hook ownership, and exact-artifact certification are fixed.

## Must stay green

All earlier contracts. Factory never stages, commits, amends, checks out, or
changes branches; no release step mutates real provider homes during tests.

## Human checkpoint and feedback

Inspect install/doctor wording and the sanitized release report. Reversible copy
feedback is non-blocking; a missing platform/provider authority blocks release.
Repository growth, association accuracy, partial-review usefulness, and reviewer
quality become measured post-v1 improvement inputs, never permission for silent
pruning or heuristic grouping.

## Release acceptance

The original five implementation passes landed through `3f6d8ae`. GitHub Actions
run `33950555193` passed the repository gate, exact glibc Linux x64-baseline
certification, native macOS arm64 package verification, and attestations for
both candidates. The local native macOS arm64 exact-artifact journey passed all
seven deterministic stages.

A completion audit found two implementable release gaps: no production reviewer
image is published, and the certification harness has no authenticated mode for
explicitly supplied dedicated Codex and Claude Code credentials. Release remains
blocked until those seams exist, both providers certify the packaged production
path, and a macOS arm64 environment with Docker completes that same path.
Automated publication must not turn package-only macOS evidence into a release
claim. The local HTML report screenshot is also an outstanding human
presentation checkpoint, not a substitute for missing execution authority.

Milestone `6fc6c64` adds the pinned multi-architecture production image,
digest-only runtime acquisition, and the GHCR publication/provenance workflow.
The release harness now accepts an immutable reviewer reference only when both
dedicated provider credential files are explicitly supplied, then forces one
packaged-path review through Codex and one through Claude. The ordinary CI path
continues to report those credentials unavailable; this explicit mode does not
borrow a developer login or turn deterministic fixtures into authenticated
authority.
