# Personal-tool simplification

Remove systems whose maintenance cost exceeds their value for one developer.
The user approved the repository audit, except removal of installation/upgrades:
both npm and standalone installation, explicit upgrades, notices, and hook
recovery remain supported. No migration framework or speculative compatibility
layer is requested. Do not modify existing user repositories or published tags.

## Next Agent Prompt

Implement and integrate the independent cuts below, then run the existing release
and repository gates. Start from `a474615`. Keep this handoff short; update each
checkpoint with its actual result. Do not create new permanent test journeys,
report generators, or screenshot galleries for this cleanup.

- [ ] Release: ordinary packaged notices, no semantic license/SBOM gate or
  historical string blacklist. Keep executable identity/integrity needed for
  standalone upgrades. Replace avoidable custom packaging machinery.
- [ ] Decisions: derive observations from accepted ledgers; persist human actions,
  not duplicate derived observations. Bind action concurrency to source records.
  Remove the unused continuity-association schema and its consumers.
- [ ] Bundles: the verified private snapshot is execution authority. Stop repeated
  full verification during ordinary metadata reads and post-execution checks of
  an irrelevant original bundle. Keep snapshot creation, container-entry,
  recovery, citation and submission validation.
- [ ] Journal: remove the lifetime sequence ceiling without making pending work
  or recovery unbounded. Preserve crash recovery and safe frozen preparations.
- [ ] Harness: one home for live fixtures/current baselines; remove historical
  report tests and obsolete generated assets. Consolidate overlapping browser
  and CLI setup while preserving distinct behavioral assertions.
- [ ] Process: shrink repository rules and remove duplicated generic process
  instructions that force artifact growth. Keep practical project constraints.
- [ ] Integrate, review, verify supported packages and existing installed journey,
  reconcile docs, report measured deletions, archive this small rationale.

## Invariants

Secret preparation precedes Git publication and identity. Provider originals and
foreign settings remain untouched. Hooks fail open. Partial review work remains
useful, unchanged work does not spin, and human action targets stay exact.
Docker remains the reviewer boundary. Source/env reads stay confined. Tests that
touch provider homes or `.factory` remain disposable Docker tests.

Each cut uses the narrowest existing behavior test, demonstrates its relevant
failure, and removes obsolete tests only when their contract is intentionally
deleted. Root build/format/lint/types/tests and release checks run at closeout.
Preserve current UI appearance; browser consolidation is not a visual redesign.

Private SQLite BLOB storage was an audit exploration, not an approved prerequisite
for these cuts: replace private CAS only if a bounded comparison proves a simpler
implementation without worse large-transcript behavior. Do not add a second
storage mode or migration service merely to chase line count.
