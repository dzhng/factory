# Choice-audit reviewer

Factory audits choices an implementing agent made because direction was absent.
Its primary review surface is a cited, standalone explanation the user can judge
without reading the transcript—not a generic list of code defects.

The [audit contract](contract.md) owns verdicts, history semantics, and typed
submissions. The consolidated [implementation choices](choices.md) record
discretion exercised while building this feature. [Research](research.md)
explains why typed tools are the model-facing seam.

## Why a submission stream

Asking a model to print a flawless final JSONL document couples useful analysis
to terminal formatting. Shell flags merely move the problem to quoting multiline
explanations and nested assertions. Permissive parsing can guess a meaning the
model never intended and cannot give correction feedback during the run.

Factory instead supplies a narrow stdio tool surface in its immutable reviewer
image. A submitted choice is validated and durably acknowledged while the model
is still working. The provider owns argument encoding; Factory owns semantics,
citation resolution, identity, and publication. Provider final prose remains
private diagnostic output, never a second source of review meaning.

## Independent axes, explicit history

A verdict says whether an observed choice was a good call. Its effect says what
happened to that choice. Human confirmation says whether the user supports the
recorded observation. None substitutes for another: confirming an unsound choice
does not erase the analyzer's concern or adopt its proposed correction.

Choices explain their triggering situation, missing direction, future reach,
verdict, and confidence. Unsound entries include a corrected decision; needs-user
entries include a reversible provisional call. A completed empty audit needs a cited
explanation of what was checked. Later reviews change history explicitly; silence
does not remove a choice or imply approval.

## What must stay true

- Bundle content is untrusted evidence, not instructions. Citation handles resolve
  only inside the verified immutable bundle.
- Factory derives durable IDs and admits only validated semantic submissions.
  Tool schemas improve encoding reliability, not trust in the model.
- Exact retries are idempotent; conflicting content never overwrites accepted
  history. Completion is explicit, not inferred from a friendly final message.
- A valid unfinished prefix survives as partial work. Input limitations and
  provider execution failure remain distinct from submission completeness.
- The [sanitization boundary](../evidence-sanitization/contract.md) prepares every
  portable output before identity. No raw-response fallback bypasses it.
- The browser ranks choice attention deterministically and keeps verdict,
  lifecycle, canonical scope, and human status distinct.

## Owners and integration discoveries

The [contract package](../../../packages/contract/README.md) owns the shared draft
fold; [review acceptance](../../../packages/review/README.md) owns publication.
The [reviewer](../../../packages/reviewer/README.md) owns the prompt, provider
configuration, and packaged server. [Domain projections](../../../packages/domain/README.md)
and the [local interface](../../../apps/web/README.md) own the human review surface.

The shared fold lives upstream of both server and acceptance to avoid a package
cycle. Pinned-provider experiments ruled out Claude safe mode because it also
suppressed explicitly configured tools, and ruled out a top-level conditional
tool schema because the client omitted a required tool. Closed provider settings
and a portable advertised schema preserve the intended authority while the
shared validator enforces all semantic conditions. These are observed client
constraints, not reasons to loosen acceptance.

## Verification

The [browser workbench](../../../packages/test-harness/src/run-local-ui.ts) checks
choice explanations, confirmation targets, ordering, and read-only states at wide
and narrow viewports. The [installed journey](../../../packages/test-harness/src/run-installed-audit.ts)
covers deterministic providers, partial submissions, committed-only reconstruction,
and exact citations through actual CLI and Docker execution. Real-model judgment
quality is separate. Historical visual comparisons remain in Git history.
