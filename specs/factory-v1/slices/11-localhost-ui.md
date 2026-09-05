# 11 — Short-lived localhost UI

Status: **implemented**

## Contract

`factory open` starts a short-lived server bound to `127.0.0.1` and displays
Sessions, Turns, branch observations, PRs, exact/weak associations, triggers,
reviews, evidence limitations, coverage, diagnostics, and canonical decisions.
Its only writes are schema-validated append-only decision and partial-coverage
actions already owned by `review` services. It is not a daemon or second source
of truth.

## API seam

```ts
buildUiProjection(records: RepositoryRecords): UiSnapshot;

serveLocalUi(input: {
  host: "127.0.0.1";
  snapshot: () => Promise<UiSnapshot>;
  actions: Pick<ActionPort, "appendDecision" | "acceptCoverage">;
}): Promise<LocalUiHandle>;
```

The browser receives no runtime database, machine paths, credentials, arbitrary
filesystem access, process execution, or generic record mutation endpoint.

## Playable artifact

The browser lab renders deterministic states covering empty, active capture,
workspace review, exact and ambiguous PR association, partial coverage, failed
review, canonical confirmation, detached HEAD, missing GitHub, corrupt data,
and upgrade-required data. Its action callbacks capture and assert the exact
intent sent by the browser. The packaged CLI vertical separately runs
`factory open` against a materialized two-provider repository, proving the
projection is rebuilt from real portable records. A second repository-backed
journey sends both action kinds through the real HTTP server and verifies that
all existing evidence stays byte-identical while only the declared action
directories gain files.

## Verification

- Projection rebuilds exclusively from `.factory` and uses the same pure folds
  as CLI behavior.
- HTTP tests prove loopback binding, short lifecycle, CSP/security headers,
  escaping, bounded raw-evidence delivery, action schema validation, stale-
  action rejection, and no mutation outside declared action directories.
- Browser journeys cover keyboard navigation, accessible names, narrow/wide
  layouts, visible provenance, and clearly distinct weak/exact/partial states.
- Capture stable screenshots. Run screenshot regression, then mandatory
  unprimed `screenshot-critique` as the last acceptance check. When a prior or
  reference image exists, also run `compare-screenshots`.

## Delegated decisions

Framework, compiled static-asset implementation, reversible spacing, type,
color, component names, and client state library. Information hierarchy,
provenance/limitations, action set, and loopback-only authority are fixed.

## Must stay green

No public bind, login fiction, daemon, hosted dependency, mutable runtime
authority, or generic `.factory` writer appears.

## Human checkpoint and feedback

Open accepted candidates with `preview-shots`, allow roughly five minutes for
feedback, record the evidence-based choice, close the shots, and proceed if the
user is silent. If provenance, association strength, or confirmation state is
ambiguous, revise information hierarchy before visual polish.
