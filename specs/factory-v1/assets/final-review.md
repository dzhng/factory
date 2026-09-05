# Whole-spec review

Scope: the full implementation from `c1b23a7` through `4008fa1`, followed by
focused regression and integration passes. This is separate from the earlier
[implementation review](implementation-review.md).

## Findings and follow-through

- **Resolved — bounded file acquisition.** Independent review found
  that oversized files were still read and hashed to EOF, including during race
  sentinels. A sparse-file read-accounting regression confirmed work far beyond
  the configured limit. Excluded bytes must remain unknown, not be reported as
  either verified equal or verified changed. Reads now stop at the admission
  ceiling, including growing files and race sentinels. Exact-byte regression
  also exposed and fixed shared-buffer corruption across read chunks.
- **Resolved — concurrent attempt cleanup.** Concurrent acceptance reconciliation
  and finalization reproduced a missing lock path. Attempt creation, recovery,
  and deletion now share stable locks outside disposable state; repeated cleanup
  succeeds. The regression and owning reviewer suite passed; independent review
  accepted the fix.
- **Resolved — owned-root validation.** Existing non-directory roots
  could be skipped during record reads, hiding history behind an apparently
  valid projection. Record reads now refuse corruption and verification reports
  it, including special files without opening them. Unrelated content is preserved.
- **Resolved — reconstruction EOF/error distinction.** The native boundary no
  longer reads mutable `errno` after returning into JavaScript. The
  [regression evidence](reconstruction-directory-read.md) separates the proven
  failure mechanism from the unobserved cause of the original intermittent
  occurrence. Docker and native macOS checks passed, including the previously
  failing installed-CLI association scenario.
- **Resolved — interleaved Session event positions.** Extending the release
  journey reproduced a valid Session resume whose global journal positions had
  gaps occupied by another Session. Capture and review now preserve strict order,
  exact claim membership, range endpoints, and raw-object inventory without
  requiring per-Session positions to be globally consecutive. Capture and planning
  regressions passed, including rejection of omitted, reordered, and duplicate
  evidence; independent review was clean.
- **Resolved — exact-artifact incremental journey.** The release harness
  previously captured everything before its first review and did not exercise
  later evidence followed by an unchanged no-op. The extended installed-artifact
  journey pins new Stop coverage and prior-ledger delivery, then traps Docker to
  prove unchanged review reuses the exact immutable attempt. Its passing native
  fixture candidate is not final release authority.
- **Resolved — default test boundary.** Bundle and credential filesystem cases
  now run in Docker; pure planning remains native. Default coverage is retained.
- **Resolved — oversized-output oracle.** The lab now separates container scratch
  output from the host's bounded response prefix. Disabling the production
  truncation marker made the new assertion fail; restored production code passed.
  Independent review was clean.

The integrated local build, formatting, lint, type, and test gates passed, along
with the browser regression gate, workspace/PR CLI journeys, execution lab, and
native macOS directory-inventory checks. Fresh visual review of the expanded
release report found pre-existing mobile hash overflow and clipped authority
text; that report-layout correction remains in progress.

## Remaining authority

The integrated [live capture certificate](live-capture/README.md) distinguishes
historical actual callbacks from current authentication readiness. The latest
Claude attempt failed authentication. No host login was modified. The final
exact candidate still needs all native quality gates, both authenticated review
authorities, publication provenance, and specification closeout.
