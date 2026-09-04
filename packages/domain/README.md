# Domain projections

This package owns pure folds over immutable Factory records. Pull-request
association is direct and many-to-many. It joins an immutable Turn to its
stable RepositoryObservation and uses only the observed Git object as proof.
A provider-derived repository mapping classifies the source as base or
different; missing or conflicting mappings leave that classification
unavailable without discarding exact SHA evidence. Branch names, time, paths,
and worktree identity are context only.

Manual inclusion is an explicit human assertion, never relabeled as verified.
When a later complete commit set proves old SHAs absent, the fold emits another
immutable fact and leaves the original association intact. Partial membership
never proves absence. Code-state continuity remains a
public format variant but no fold produces it until a separate corpus proves a
deterministic algorithm.
