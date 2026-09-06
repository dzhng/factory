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
