# Sanitized review evidence

Factory preserves implementation reasoning without committing recognizable
credentials or pages of low-value tool output. The boundary is every
Factory-generated committable byte, including objects left unreferenced by an
interrupted publication—not merely the text sent to a reviewer.

The [policy contract](contract.md) owns exact reduction, discovery, identity, and
failure semantics. The [implementation choices](choices.md) explain the decisions
made where the plan left discretion. [Research](research.md) records parsing
sources and rejected shortcuts. This feature and the [choice-audit reviewer](../choice-audit-reviewer/README.md)
share one publication boundary.

## Why preparation precedes identity

Redaction changes bytes. Filtering a finished manifest would invalidate its
references, while filtering only reachable objects would leave physical secrets
eligible for Git. Leaves are therefore prepared before their content references,
and parents are built from those exact safe references. Publication accepts
repository-bound preparation authority, not a caller's claim that arbitrary bytes
are safe.

Original Git race state and sanitized content identity remain different facts.
Two original files can redact to the same text without proving that code did not
change. Typed Git identities, Factory IDs, and exact object references retain their
structural authority; an arbitrary message that resembles a hash does not gain
that exemption.

## What must stay true

- User and assistant reasoning and tool inputs remain untrimmed. Recognized tool
  results share one Unicode-aware context budget, after redaction.
- Secret discovery treats nested ignored env files as data, never executable
  shell. Intentional exclusions are explicit; unexpected discovery failure never
  permits raw fallback.
- Raw provider originals and private attempts stay private. Factory does not
  rewrite user source, foreign files, or existing Git history.
- Recoverable publication freezes exact safe bytes before its first portable
  write. Retry after env rotation uses that preparation, not a new dictionary.
- Source snapshots are readable review evidence, not executable backups.
  Unsupported source and malformed message fragments become explicit omissions.
- Readable partial evidence still receives best-effort review. Deterministic
  reduction and previously analyzed context must not create a repeated-review loop.
- Detection remains best effort. It cannot recover deleted historical env values
  or recognize every possible credential encoding.

## Ownership and rejected alternatives

The [sanitization package](../../../packages/sanitization/README.md) owns matching
and reduction; provider adapters own native message structure. The
[repository](../../../packages/repository/README.md) owns prepared publication.
The [journal](../../../packages/runtime-journal/README.md) and
[reviewer attempts](../../../packages/reviewer/README.md) retain their existing
recovery responsibilities. There is no second transaction service, public
secret dictionary, compatibility format, or redaction setup step.

A writer-side byte filter was rejected because it would silently change graph
identity. Recomputing safe bytes on retry was rejected because today's env values
cannot reproduce yesterday's immutable publication. Whole-hash removal was
rejected because structural identities establish provenance and citation
authority. The internal recovery interface is an ownership boundary for trusted
Factory code, not a sandbox against a repository the developer already runs;
[SECURITY.md](../../../SECURITY.md) owns that trust model.

## Verification provenance

The combined [installed journey](assets/installed-audit/README.md) names its exact
native candidate and separates actual Factory/Docker execution from synthetic
provider and GitHub responses. It checks retained reasoning, reduced results,
safe physical files, interruption/retry, and committed-only reconstruction.
It does not certify real-model judgment quality.

Earlier synthetic checkpoints preserve readable evidence for the separate
boundaries: [source observation](assets/git-observation-workbench/report.json),
[PR observation](assets/pr-workbench/report.json),
[Codex capture](assets/capture-vertical/sanitized-capture-codex.json),
[Claude capture](assets/capture-vertical/sanitized-capture-claude.json),
[journal crash recovery](assets/journal-crash/report.json),
[review publication](assets/review-publication/review.json), and
[human actions](assets/review-publication/action.json).
Their original authority is retained; a pure policy probe or Bun-driven capture
test is not relabeled as an installed native journey. The
[test harness](../../../packages/test-harness/README.md) owns runnable gates.
