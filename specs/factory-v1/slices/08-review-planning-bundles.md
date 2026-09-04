# 08 — Review planning, incremental coverage, and bundles

## Contract

Bare `factory review` selects the exact current workspace plus verified pending
Stops and clearly labeled weak same-branch candidates; `--session` narrows it.
`factory review --pr N` selects only exact/verified PR associations. Pending
Stops coalesce through a frozen watermark. Fully covered unchanged subjects are
no-ops. The planner includes readable partial evidence, excludes corrupt or
unsafe bytes, and freezes every input into a self-contained verified bundle.

## API seam

```ts
type ReviewSubject =
  | { kind: "workspace"; observation: RepositoryObservationRef }
  | { kind: "pull-request"; observation: PrObservationRef };

planReview(input: ReviewInputs): ReviewPlan;
buildBundle(plan: ReviewPlan): Promise<VerifiedReviewBundle>;
verifyBundle(bundle: BundlePath): Promise<BundleVerification>;
foldCoverage(input: CoverageRecords): CoverageView;
```

Planning and coverage are pure folds over append-only evidence. The bundle pins
the subject, watermarks, code, diffs, associations, prior ledger, policies,
limitations, and complete transitive object inventory.

## Runnable artifact

`bun run lab:review-plan` produces offline-readable workspace and PR bundles
for complete, readable-partial, corrupt, unchanged, continuing-Session,
force-push, and policy-change fixtures, together with stable inclusion reasons
and bundle digests.

## Verification

- Permuting record and filesystem order produces identical plans and digests.
- Incremental PR review contains new evidence, the full current PR diff, and the
  prior canonical ledger without re-reviewing covered Session ranges.
- `--full`/`--force` reanalyzes; unchanged full coverage returns `already
  reviewed` without Docker.
- Partial plans enumerate attempted, unavailable, corrupt, unsafe, weak, and
  deliberately excluded inputs separately. Readable partial is eligible;
  corrupt foundational bytes are not verified.
- Partial triggers remain unsettled. Explicit acceptance later settles only the
  exact attempted watermarks and never edits triggers or reviews.
- Reconstruct the bundle into a fresh directory with no `.git` and prove review
  code cannot need repository state outside it.

## Delegated decisions

Bundle container/compression format, explain rendering, and cache mechanics.
Eligibility, association strength, watermark meaning, full-review triggers,
partial semantics, and digest inputs are fixed.

## Must stay green

Workspace reviews have no invented subject key. Review runs are immutable and
pin their evidence watermark. Weak evidence is visible but never silently
promoted.

## Human checkpoint and feedback

Read one complete and one partial plan plus the ambiguous inclusion explanation.
If users cannot distinguish useful partiality from unsafe input, split
classification from bundle construction before Slice 09.

## Implementation evidence

`@factory/review-plan` owns the pure coverage/selection fold, typed portable
graph loader, and compact verified directory bundle. The promoted Docker lab
under `../assets/review-plan/` includes workspace and partial-PR bundles and
records deterministic complete, readable-partial, corrupt, unchanged,
continuing-Session, forced, and policy-change plans. Bundle acceptance reuses
the repository's descriptor-rooted read and tree-inventory capabilities and
proves source-repository-independent verification and code reading.
