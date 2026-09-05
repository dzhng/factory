# 09 — Isolated review execution and immutable acceptance

Status: **implemented; production image authority passes and automatic local
provider authentication is ready for exact certification**

## Contract

Execute exactly one verified bundle in an ephemeral container. `reviewer:auto`
uses the provider of the newest covered Stop as authoring context, prefers the
other authenticated harness, and falls back to a fresh isolated Session of the
same harness; mixed-provider evidence does not run two reviewers. Validate
bounded semantic output and citations, then append exactly one complete,
partial, or failed immutable review. Default findings are advisory;
`--fail-on` is explicit enforcement. Execution/validation failure is nonzero.

## API seam

```ts
interface ReviewerExecutor {
  run(input: VerifiedReviewBundle, choice: ReviewerChoice): Promise<RawAttempt>;
}

validateReview(bundle: VerifiedReviewBundle, raw: RawAttempt): ValidatedAttempt;
acceptReview(attempt: ValidatedAttempt, store: RepositoryStore): Promise<ReviewRef>;
```

Mount planning and process supervision belong to `reviewer`; semantic
validation and immutable acceptance belong to `review`. Raw model output never
directly becomes ledger authority.

## Runnable artifact

Run `factory review` and `factory review --pr 42` against deterministic fake
providers, then guarded real cross-harness clients. The output names review ID,
disposition, limitations, provider/model/version, coverage effect, and result
paths.

## Verification

- Reuse Slice 02's exact mount/isolation proof for the production executor.
- Cover success, timeout, cancellation, malformed/truncated/oversized output,
  invalid citations, container crash, concurrent attempts, duplicate retry,
  orphan cleanup, expired auth, and missing Docker.
- A readable semantic subset produces `partial`; no meaningful validated result
  produces a small sanitized `failed` attempt while full logs stay runtime-only.
- Complete/partial/failed results and raw response are immutable; citation
  validation resolves only bundle inventory.
- Explicit partial acceptance appends a coverage action; it moves no Session or
  trigger file and does not relabel the review.
- Before/after Git and host-provider sentinels remain identical.

## Delegated decisions

Versioned prompt prose, parser internals, temporary names, and progress display.
Mount topology, selection rule, result dispositions, citation authority,
coverage effects, and failure sanitization allowlist are not delegated.

## Must stay green

No host fallback, checkout mount, Docker socket, writable auth, secret-bearing
portable logs, or unbundled repository read is possible.

## Human checkpoint and feedback

Inspect the first complete and partial Factory reviews. Quality feedback changes
versioned prompt policy through the fast fake/offline loop; it does not widen
container authority or make partial output complete.

## Shipped boundary

The installed command observes the exact current workspace or GitHub PR,
serializes concurrent work per subject, plans once with its resolved reviewer,
and either reports the exact covering prior review or executes one verified
bundle. The container receives only verified read-only evidence, content-bound
read-only provider authentication, and one bounded semantic response channel.
Git-common state owns recovery and transient response retention; `.factory`
receives only manifest-last immutable review groups and explicit coverage
actions.

The public, attested multi-architecture production image at
`ghcr.io/dzhng/factory-reviewer@sha256:73edb8116985083ee5f23efac6b7a093591196799b04124cb07df98898bc767d`
passed the complete isolation oracle from its remote digest. Factory now reuses
existing CLI authentication automatically: provider-owned files remain
identity-bound and read-only, while macOS Claude Keychain authentication is
reduced to `claudeAiOauth` in private attempt state and removed after execution.

Durable ownership is documented by the [capture](../../../packages/capture/README.md),
[review planning](../../../packages/review-plan/README.md),
[reviewer](../../../packages/reviewer/README.md),
[review acceptance](../../../packages/review/README.md), and
[repository](../../../packages/repository/README.md) package boundaries.
