# 02 — Reviewer isolation and authentication oracle

Status: **implemented for the provider-independent Linux boundary; live
provider authority remains explicitly unavailable**

## Contract

Prove, with an instrumented fake provider, the provider-independent container
boundary required to execute a headless reviewer using only a verified
read-only input bundle, provider-owned authentication mounted read-only,
network access, and one writable output directory. No live checkout, `.git`,
Docker socket, unrelated home data, or writable credentials enter the
container. Record current provider and platform authority gaps exactly; Slice
09 must close them against the packaged Codex and Claude execution paths.

## API seam

```ts
type MountPlan = {
  bundle: { hostPath: string; containerPath: "/bundle"; mode: "ro" };
  output: { hostPath: string; containerPath: "/out"; mode: "rw" };
  auth: readonly ReadonlyAuthMount[];
};

planReviewerIsolation(input: IsolationInput): MountPlan | IsolationRefusal;
runIsolationProbe(plan: MountPlan): Promise<IsolationReport>;
```

Mount planning is pure and typed. Only the future `reviewer` package may turn a
verified plan into Docker arguments.

## Runnable artifact

`bun run lab:reviewer-isolation` emits a sanitized report of mounts, uid,
provider/version, negative access checks, writable locations, output hashes,
process cleanup, and network observations.

## Verification

- Inspect actual Docker create/run arguments and inspect from inside the
  container that auth and bundle writes fail while `/out` writes succeed.
- Prove checkout sentinels, `.git`, Docker socket, other-provider auth, and
  unrelated host paths are absent.
- Exercise success, timeout, cancellation, killed descendants, and cleanup with
  a fake provider. Record Codex, Claude, and platform certification as verified
  only when the packaged Slice 09 path runs with explicit test credentials.
- Grep image history, report, output, logs, and fixtures for credential values.

## Delegated decisions

Base distribution, container entrypoint, and disposable cache layout, provided
the final image is digest-addressable and the report records every relevant
version.

## Must stay green

Provider auth stays provider-owned and read-only. The security model is not
weakened for convenience, and Docker unavailability has no host-review fallback.

## Human checkpoint and feedback

Review the sanitized isolation report. If a provider requires writable state,
reslice that provider into read-only source auth plus a disposable derived
overlay and update `SECURITY.md` before proceeding. A required broad home mount
or credential mutation blocks that provider rather than widening both.

## Implementation evidence

`bun run lab:reviewer-isolation` builds a digest-addressed fake-provider image
and writes sanitized JSON and HTML reports. The lab observes the created
container rather than trusting the requested plan, then checks immutable input,
read-only file authentication, the sole writable output mount, network routing,
non-root execution, dropped capabilities, timeout, cancellation, descendant
cleanup, and credential-value absence.

The local authority run verified Docker `linux/arm64`, and the native CI release
lane verifies the same provider-independent boundary on glibc `linux/amd64`.
Codex 0.144.4 and Claude Code 2.1.261 are credential-free image-certified, but
no dedicated test credentials were configured, so neither provider was
reported as authenticated. Real-provider execution is deliberately resliced to Slice 09,
because it depends on the production image and provider invocation adapters;
Slice 09 must obtain those authorities before release acceptance.
