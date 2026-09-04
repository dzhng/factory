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
