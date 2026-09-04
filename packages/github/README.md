# GitHub evidence

This package turns optional GitHub CLI observations into immutable pull-request
facts. Provider repository identity—not a
mutable owner/name—is the durable grouping key, with the hostname separating
GitHub Enterprise installations.
An attempt files under the first stable base identity it sees; a later identity
change is a race, not permission to re-key the attempt.

Factory reads metadata before and after a bounded diff acquisition and only
publishes fields shared by both views. A readable coherent diff remains
available when commit membership, a deleted ref, or optional code capture is
incomplete; the record discriminates that partial evidence so downstream code
cannot mistake a prefix for a membership set. Missing foundational evidence or
a changing view is typed unavailability.

The adapter reuses `gh` authentication without reading or storing its token.
Association policy is a pure fold owned by `@factory/domain`. Persistence
publishes immutable evidence first and a validated completion marker last;
orphaned prefixes from a crash are not projected. Provider acquisition bounds
also cover content-addressed evidence writes. A store that finishes after its
deadline can leave only an unreferenced object, which is inert because no
observation or completion marker names it. Optional code capture has its own
smaller phase deadline inside that total budget, so a hanging snapshot provider
does not consume the entire PR acquisition window.
