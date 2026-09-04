# Domain projections

This package owns pure folds over immutable Factory records. Pull-request
association is direct and many-to-many: an exact Git object match may connect a
Session to a PR observation in its base repository or its fork head repository.
Branch names, time, paths, and worktree identity are context only.

Manual inclusion is an explicit human assertion, never relabeled as verified.
When later PR facts invalidate old proof, the fold emits another immutable fact
and leaves the original association intact. Code-state continuity remains a
public format variant but no fold produces it until a separate corpus proves a
deterministic algorithm.
