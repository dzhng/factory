# Review planning and bundles

This package owns the deterministic boundary between append-only repository
evidence and reviewer execution. Planning is a pure fold: it classifies every
candidate trigger, preserves exact per-Session ranges, and distinguishes
already analyzed evidence from prefix-safe accepted coverage.

A review bundle is a disposable directory containing the frozen plan and every
referenced content object. Its manifest and object paths are canonical and
content-addressed, so verification in a fresh directory needs neither the live
checkout nor Git metadata. `@factory/reviewer` may execute only after this
package returns a verified bundle.

Repository discovery, candidate graph loading, history folding, coverage, and
portable bundle verification have separate owners under `src/`. That split is
a trust boundary: planning consumes only immutable projections produced from a
descriptor-confined repository snapshot, while bundle verification rebuilds
the same joins without consulting the live repository.

Subject acquisition belongs here as the upstream edge of planning. Workspace
subjects persist an exact Git observation; PR subjects combine a fresh provider
observation only with verified committed Session and association graphs.

This package decides whether execution is necessary; it does not start Docker.
The execution owner stops on every status except `ready`, then accepts only a
bundle that independently verifies. A verified bundle separately identifies
target-repository records and CAS objects, so bundle-derived context such as a
prior ledger cannot be mistaken for target CAS authority.
