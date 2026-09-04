# 09 — Isolated review execution and immutable acceptance

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
