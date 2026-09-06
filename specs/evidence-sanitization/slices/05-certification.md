# 5 — Installed-CLI certification

Depends on slice 4. This is the release-readiness verdict, not permission to tag
or publish a new npm version automatically.

## Contract and seam

Add a feature-owned journey in `packages/test-harness` using the actual packaged
CLI in a disposable Docker repository/home. The consumer must need no Bun and no
redaction setup. Use synthetic credentials as test content, never live tokens.
Provider/model and `gh` fixtures are declared external-boundary authority, not
claims of real authenticated model execution.

## Red/green and inspectable result

Exercise both provider captures, nested ignored env discovery, source snapshots,
workspace and PR review, accepted model output, and one localhost action. Include
crashes around preparation/publication and retry after env rotation. Commit the
result inside the disposable repository and reconstruct a review from a fresh
clone with neither journal nor env files. Verify the graph and all citations.

Inspect every Factory-owned physical file, including unreferenced CAS and staging
prefixes, for seeded secrets. Inspect decoded JSON/encoded paths too, so escaping
does not fool the test. Verify unchanged original provider transcripts, retained
assistant reasoning, result-budget markers, and explicit binary/source omissions.
Trap provider execution on unchanged repeated review to prove no extra review.

Produce a compact report outside the working repository by default, with exact
candidate identity, commands, authority, pass/fail results, and only synthetic
content. Record its invocation and report location here. The user can inspect the
result without blocking progress on a reversible presentation choice.

Run the root build, format check, lint, type check, test, and supported-platform
gates once at closeout. Use the repository's current runners rather than inventing
a second release harness. Missing Docker/platform authority is a reported gap,
not a synthetic pass. No real provider configuration may be changed by tests.

## Handoff and freedoms

Reconcile docs and stale lossless-evidence claims, run review and independent
Codex review, then commit/push the green milestone. Delegate fixture organization
and runner naming. Do not delegate the installed boundary or replace it with
unit-test-only evidence. Update the Next Agent Prompt with the final verdict and
use close-spec when the implementation is finished.
