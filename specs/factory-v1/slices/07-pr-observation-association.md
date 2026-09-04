# 07 — Pull-request observation and direct associations

## Contract

When `gh` is available, freeze one exact PR observation—repository identity,
number, state, base, head, commit evidence, diff/code snapshot, availability,
and provider update facts—and append direct Session-to-PR association evidence.
Absence or failure of `gh` is typed unavailability and never disables capture or
workspace review. Branch, time, path overlap, and worktree identity remain weak
workspace context, never PR association evidence.

## API seam

```ts
interface PrObserver {
  observe(ref: PullRequestRef): Promise<PrObservation | PrUnavailable>;
}

type AssociationEvidence =
  | ExactCommitAssociation
  | ExactHeadAssociation
  | VerifiedCodeStateContinuityAssociation
  | ManualAssociation;

deriveAssociations(input: AssociationInputs): readonly AssociationEvidence[];
```

Every association is scoped to an exact immutable PR observation. Later
invalidation is another append-only fact.

## Runnable artifact

A deterministic PR workbench renders exact, ambiguous, force-pushed, base-
changed, fork, enterprise-host, unauthenticated, and missing-`gh` cases with an
explanation of accepted and rejected evidence.

## Verification

- Exact commit and head matches, one PR/many Sessions, one Session/many PRs,
  renamed repository, forks, GHES, capped/incomplete commit data, and closed/
  merged/reopened observations.
- Force-push and base change retain history and mark divergent current code for
  full review.
- No association arises from branch name, timing, path overlap, or worktree.
- Old associations are never edited or deleted.
- Start with exact commit/head only. A false-positive-heavy corpus must prove a
  deterministic continuity algorithm before enabling that evidence kind.

## Delegated decisions

Bounded `gh` invocation mechanics, runtime caching, and explanatory formatting.
Repository identity, accepted evidence kinds, and unavailable-state semantics
are public decisions.

## Must stay green

Branches remain observations. There is no Epic/workstream layer, GitHub token
store, checkout mutation, or direct GitHub prerequisite for local behavior.

## Human checkpoint and feedback

Review explanations for exact, ambiguous, and force-pushed cases. Too few exact
associations triggers a separate continuity-proof slice; it does not authorize
heuristic inference.
