# Implementation review

Verdict: **findings resolved**. Original scope: implementation from `c1b23a7` through
`2a73e3c67ff5cd21510c1b42c3a82431685cf281`.

## Behavior findings

1. **Resolved P1 — Incremental acquisition could starve later Sessions.**
   [The loader](../../../packages/review-plan/src/index.ts) sorts all requested
   Session keys and applies `maxSessions` before accounting for historical
   coverage. With two equally ranked Sessions and a limit of one, the first
   remains admitted after it has been reviewed; the second remains excluded.
   The later planner can recognize settled evidence but cannot reacquire the
   Session already excluded by the loader. Admission now uses the existing
   coverage fold to keep settled triggers out of the acquisition budget while
   retaining their coverage in the plan. Unsettled triggers remain eligible;
   full and force modes still reacquire covered evidence. A regression through
   the production loader failed before the fix and now advances from the first
   Session to the second, verifies the resulting bundle, and checks both replay
   modes. Independent Codex review found no remaining issue in this fix; the
   full build, formatting, lint, type, and test gates passed.
2. **Resolved P2 — Global reviewer preferences did not affect execution.**
   [The review command](../../../packages/cli/src/review.ts) passes only the
   repository reviewer setting to selection. In a disposable Docker repository,
   `configure --global --reviewer claude` reported Claude, but the next review's
   output and immutable manifest recorded Codex. Authentication was deliberately
   absent; the failed attempt still proves which reviewer was selected. The
   existing effective-configuration fold now governs execution as well as the
   configuration command's display. The installed CLI regression proves global
   selection and repository override precedence in Docker.
3. **Resolved P2 — Automatic review was an accepted but inert preference.**
   [The CLI](../../../packages/cli/src/index.ts) persists `automaticReview`, but
   no production consumer dispatches reviews from it. A Docker reproduction
   enabled repository automatic review and sent SessionStart and Stop through
   the installed CLI. Capture succeeded and created a trigger, with no review.
   Capture now wakes the installed CLI asynchronously when opted in, reusing
   durable triggers and the subject lock. SessionStart recovers missed wakes;
   attempted triggers cannot cause an unchanged-failure retry loop. Docker
   regressions cover script and compiled-native dispatch, repository override,
   failure evidence, and repeated Stops without duplicate attempts.
   Independent review additionally caught worker accumulation and invisible
   non-exception failures. A non-waiting worker lock and private failure
   diagnostics address both, with Docker regressions that first failed.
   A follow-up contention finding was reproduced with a linked checkout;
   worker ownership is now per-worktree, with a post-unlock trigger recheck.
   A private fixed-size pending-set fingerprint also suppresses unchanged
   no-progress and pre-manifest failures without changing manual retry or
   coverage semantics.
   The final contention correction preserves the pre-attempt pending set when
   there is no progress, so newly arrived triggers survive the post-unlock check.
   The repository-wide build, format, lint, type, and test gates passed, with
   affected suites rerun after follow-up fixes. One CLI reconstruction-directory
   failure did not reproduce in the focused rerun or subsequent CLI suite runs.
4. **Resolved P2 — The UI could not report GitHub canonical-branch drift.**
   [UI composition](../../../packages/cli/src/open.ts) supplies only repository
   records to the [projection](../../../packages/domain/src/ui.ts). Neither
   acquires a current GitHub default-branch observation. Its diagnostics contain
   missing canonical configuration and decision-fold problems, but cannot
   detect the disagreement promised by the spec. Display refreshes now reuse
   the provider-backed observation and diagnostic policy used by `doctor`, with
   a 750 ms discovery deadline. Action validation skips GitHub entirely.
   Docker regressions cover drift, matching branches, unavailable and slow
   GitHub, unchanged configuration, and local-only action validation. Real
   browser captures at desktop and mobile widths passed fresh visual critique;
   the existing mobile severity bar remains legible. Independent code review's
   latency finding was fixed and its follow-up passed.

All identified behavior findings are resolved.

## Shape and documentation

The main ownership boundaries are explicit: provider adaptation, private capture
durability, portable writes, history projections, planning, container execution,
and acceptance. Configuration display and execution now share the precedence
fold. Automatic dispatch uses the existing review owner rather than a second
queue or acceptance path.

The root documentation traversal had no broken links, but seven component
READMEs were unreachable. The root now links each ownership boundary. The spec's
completion claim and lengthy historical handoff were replaced with the open
review status and pointers to retained release evidence.

## Evidence and limits

An independent `codex review --base c1b23a7` identified the acquisition starvation
and both configuration defects. All three were confirmed against the source;
none were dismissed. The primary pass additionally identified missing UI drift
observation and the documentation navigation gap.

The configuration reproductions ran in disposable, networkless Docker homes.
No developer provider configuration or authentication was changed. Existing CI
and authenticated release evidence remain valid for the paths they exercised;
they do not cover the defects above. No claim of exhaustive correctness follows
from this review.
