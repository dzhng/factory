# 02 — Reviewer isolation and authentication oracle

## Contract

Prove that each current provider CLI can execute headlessly in an ephemeral
Docker container using only a verified read-only input bundle, the minimum
provider-owned authentication mounted read-only, network access, and one
writable output directory. No live checkout, `.git`, Docker socket, unrelated
home data, or writable credentials enter the container.

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
  a fake provider, then real Codex and Claude with explicit test credentials.
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
