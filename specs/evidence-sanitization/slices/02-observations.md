# 2 — Sanitized code and PR observations

Depends on slice 1.

## Contract and seam

Move GitObserver's content preparation before candidate object references and
CodeManifest construction. Source race checks still observe original bytes;
portable manifests reconstruct the sanitized review tree. Apply the same seam to
optional PR code capture, patches, selected GitHub metadata objects, and their
structured observations. The repository and GitHub owners retain their current
observation responsibilities; they consume one sanitizer context per acquisition.

Add the contract-owned transformation summary and fixed omission reasons to the
relevant objects/records. Change misleading public raw-evidence names and their
consumers directly, without old-field aliases. Required locators must not be
silently redacted into different branch/path/configuration authority.

Build the complete safe observation graph before publication. When an operation
is abandoned it may use a new observation identity on retry; do not invent a
durable retry transaction for acquisitions that do not resume immutable IDs.
Every physical object published, referenced or not, is already sanitized.

## Red/green and inspectable result

Extend `packages/repository/test/git-observation.test.ts` and the GitHub workbench
under their Docker runners. Cover source, patch context, tracked `.env` omission,
binary/invalid-UTF-8 omission, symlink targets, encoded secret-bearing paths,
PR prose, and valid structural SHAs. Prove that two raw changes redacted to the
same text do not create false exact-code continuity or skipped subject review.

Reconstruct using only the stored manifest; verify every digest and length against
the resulting sanitized bytes. No test may compare a sanitized hash to an original
Git blob as if they were equivalent. Scan orphan objects from interrupted writes.
Keep deadline/race and readable-partial PR behavior green.

Extend the Git/PR workbench report with a synthetic sanitized tree and limitations.
Record its invocation and the verdict here. No browser screenshot is required.

## Handoff and freedoms

Update the security model's source/PR evidence contract and relevant package docs
with the behavior actually changed. Delegate internal helper layout and fixture
names, not content identity or omission policy. A requirement for executable
snapshots rather than review snapshots would change this slice and needs explicit
direction. Commit/push green; portable provider/review output remains unfinished
until its owning slices land.

## Source checkpoint

GitObserver now prepares source before deriving object references, retains the
original-byte race authority, and rejects sensitive branch locators. Source
entries and their manifest/observation carry contract-owned transformation
metadata. Reconstruction never discovers env values or rewrites stored bytes.

The Docker source suite passes 41 tests. New evidence covers actual interrupted
repository-store prefixes, unchanged checkout bytes, matching sanitized snapshots
with distinct original state, sensitive encoded paths, omitted binary/env source,
and unchanged symlink targets. Independent review found two P2s: BOM removal in
symlink decoding and omitted unstaged env change detection. Both were reproduced
with failing regressions and fixed. Type/lint gates and the owning repository
suite pass; the contract's existing tests remain green.

Run `bun run lab:git-observation` for the synthetic
[source report](../assets/git-observation-workbench/report.json). It reconstructs
retained reasoning with a redaction marker, reports env/binary omissions, and
proves the original checkout stayed unchanged. Verdict: useful review context.

The PR counterpart remains in progress. Integrate its preparation, metadata and
caller context before marking this slice complete. Provider capture and durable
replay follow; no broader publication-protection claim is made here.

### GitHub checkpoint

GitHub metadata and patches now use one caller-supplied sanitizer per acquisition
and prepare their complete safe graph before CAS publication. Public PR and
mapping `raw` fields are `evidence`, with transformation summaries; required
locators cannot be redirected by redaction. JSON key collisions omit the opaque
record, and env/binary/sensitive-path patch sections are omitted with fixed
limitations. Git's quoted paths are inspected in headers and format-patch
preambles. Optional code capture shares the same sanitizer and bounded private
collection, which closes when capture ends.

Verification: GitHub Docker regression cycles covered persisted sentinels,
typed SHA exemptions, unsafe locators, omitted metadata, encoded paths, and
preparation expansion without a published prefix. The GitHub workbench report
is under `assets/pr-workbench`; `bun run lab:pr-workbench` includes the Docker
package suite and shows retained redacted reasoning plus an omitted env patch.
Contract/domain selected tests and review-plan's pure/Docker suites passed.
Independent Codex review identified encoded preamble paths and swallowed
preparation-limit errors; both have red/green regression evidence and fixes.

Integration still must supply the discovered sanitizer at the production
review-plan acquisition calls. The outer publication admission API and human
association prose remain slice 4 scope; this is not full boundary certification.
