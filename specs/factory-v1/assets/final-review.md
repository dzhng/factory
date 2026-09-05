# Whole-spec review

Scope: the full implementation from `c1b23a7` through `4008fa1`, followed by
focused regression and integration passes. This is separate from the earlier
[implementation review](implementation-review.md).

## Findings and follow-through

- **Pending integration — bounded file acquisition.** Independent review found
  that oversized files were still read and hashed to EOF, including during race
  sentinels. A sparse-file read-accounting regression confirmed work far beyond
  the configured limit. Excluded bytes must remain unknown, not be reported as
  either verified equal or verified changed.
- **Resolved — concurrent attempt cleanup.** Concurrent acceptance reconciliation
  and finalization reproduced a missing lock path. Attempt creation, recovery,
  and deletion now share stable locks outside disposable state; repeated cleanup
  succeeds. The regression and owning reviewer suite passed; independent review
  accepted the fix.
- **Pending integration — owned-root validation.** Existing non-directory roots
  could be skipped during record reads, hiding history behind an apparently
  valid projection. The correction must refuse corruption, while continuing to
  preserve unrelated namespace content.
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
- **In progress — exact-artifact incremental journey.** The release harness
  previously captured everything before its first review and did not exercise
  later evidence followed by an unchanged no-op. The extended journey must use
  the installed native artifact, not workspace source.
- **In progress — default test boundary.** A test-runner audit is correcting
  confirmed unit tests that create portable Factory trees outside Docker.
  Moving those cases must preserve their default gate coverage.

## Remaining authority

The integrated [live capture certificate](live-capture/README.md) distinguishes
historical actual callbacks from current authentication readiness. The latest
Claude attempt failed authentication. No host login was modified. The final
exact candidate still needs all native quality gates, both authenticated review
authorities, publication provenance, and specification closeout.
