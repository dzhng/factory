# 12 — Installation, diagnostics, upgrade, and release proof

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

`bun run release:verify` packs and installs the exact artifact, runs the full
journey in clean Linux Docker and real macOS runners, and emits a sanitized
HTML/JSON report with artifact digest, platform/architecture, Node/Bun/Git/
Docker/provider versions, journey verdicts, and unavailable optional authority.

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
