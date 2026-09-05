# 01 — Provider and reference oracle

Status: **implemented; historical authenticated capture passed; latest combined live run unavailable**

The durable browser checkpoint is
[`assets/provider-capture-oracle/index.html`](../assets/provider-capture-oracle/index.html),
with its machine-readable evidence beside it. Donor-derived fixtures certify
the raw-byte and transcript-transition claims. A credential-free Docker process
probe certifies cross-process sequencing. Current client versions and help were
observed, and the pinned-client Docker refresh certifies Codex 0.144.4 and
Claude Code 2.1.261. The separate
[authenticated capture certificate](../assets/live-capture/README.md) proves
actual initial/resumed lifecycle callbacks, native Stop identities, readable
transcripts, and fail-open reader refusal for both pinned clients using existing
CLI logins. It does not turn optional, unobserved events into certified behavior.
The fixture report retains its narrower, explicitly fixture-derived authority.
A later Claude run failed authentication. The certificate records that current
unavailability separately; prior successful callbacks do not certify a final
release candidate or continuing credential readiness.

## Contract

Create the Node 22/Bun/Turborepo workspace and a Docker-only replication lab
that measures the donor's useful capture behavior against pinned current Codex
and Claude clients. This slice ports no production behavior. It answers whether
native Session identity, Stop identity, transcript discovery, callback order,
response requirements, and lossless unknown bytes support the approved model.

## API seam

```ts
interface CaptureProbe {
  provider: "codex" | "claude";
  clientVersion: string;
  rawEvents: readonly ObjectDigest[];
  transcriptObservations: readonly TranscriptObservation[];
  sessionIdentity: ProbeVerdict;
  stopIdentity: ProbeVerdict;
  limitations: readonly ProbeLimitation[];
}
```

The fixture corpus is test-harness evidence. It does not become a guessed
shared provider schema; exact raw bytes remain the common envelope.

## Runnable artifact

`bun run lab:provider-capture` produces a credential-free HTML/JSON report
comparing donor fixtures, freshly captured fixtures, and current event
inventories. The report links every claim to fixture bytes and records tool
versions. Its HTML is the first browser-playable checkpoint.

## Verification

- Reproduce donor transcript append, replacement, truncation, compaction,
  deletion, Stop-lag, unknown-row, and unknown-field cases.
- Reproduce concurrent sequencing and provider-valid success/failure output.
- Run all provider/config/home work in Docker with explicitly mounted test
  credentials; host provider homes are byte sentinels.
- Verify the report contains no credential values or operational host paths.
- Record which donor tests are port candidates, rewrites, negative references,
  or hosted-only deletions.

## Delegated decisions

Report layout, fixture filenames, and internal probe module layout. Do not
delegate Session/Stop meaning, lossless raw preservation, direct-hook scope, or
which current provider behavior is treated as fact.

## Must stay green

No hosted code, plugin discovery, Epic inference, donor state importer,
compatibility layer, or production format is introduced. The repository remains
greenfield.

## Human checkpoint and feedback

Review the oracle report and one readable raw fixture per provider. Missing
optional events may narrow parsed convenience fields. Missing stable Session or
Stop identity, incompatible callback latency, or irreconcilable provider
semantics triggers provider-specific reslicing before Slice 03.

## Implementation handoff

The oracle code lives in `packages/test-harness`; it is deliberately excluded
from production packages. Before Slice 03 freezes provider-derived convenience
fields, rerun the credential-free pinned-client refresh whenever a pinned client
changes. The live capture journey reuses the production attempt-scoped credential
and Docker owners; no extra login, broad provider-home mount, or second token
staging path is permitted. Raw provider bytes remain the common envelope.
Optional event claims require their own live scenario, not extrapolation from
the observed lifecycle inventory.
