# Public contract

This package is the sole authority for Factory's Git-visible schemas, canonical
encoding, compatibility boundary, and owned-path construction. Public types
explain what downstream slices may persist; runtime packages must not invent
parallel record shapes or construct `.factory` paths from unchecked strings.

The durable layout and its rationale live in the
[v1 format](../../specs/done/factory-v1/format.md). This package owns the executable
mechanics that keep those promises stable.

Choice audits have one public entry shape with verdict-specific requirements,
not generic finding/decision variants. The shared validators govern both typed
submission events and durable ledgers. Citation identity, aggregate limits,
explicit presence effects, and standalone judgment fields survive into derived
decision observations; publication owns IDs and canonical ordering.
