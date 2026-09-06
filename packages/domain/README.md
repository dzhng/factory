# Domain projections

This package owns validated, rebuildable projections over immutable Factory
records. It verifies association batches and manifest-last review groups,
resolves their exact subjects, folds coverage and canonical decisions, and
reduces those results into presentation-safe UI state. Planning, review
acceptance, and interfaces consume these projections instead of maintaining
parallel interpretations of repository history.

Pull-request
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

Decision history is another pure fold. It groups only explicit choice keys,
derives canonical scope from exact snapshots of the configured branch, and
keeps analyzer confidence, material change, and human status separate. Actions
name exact observations or disputes; the fold never spreads their effects by
similarity or rewrites earlier evidence.

Presence and judgment are independent. Assert establishes an assertion, remove
explicitly retires it, and contradict records an incompatible assertion;
silence does nothing. Only assertion and effect determine material change.
Unsound and needs-user verdicts require attention even when the assertion is a
replay or a person has confirmed it. Confirmation records the person's action;
it does not erase the analyzer's judgment or its corrected/provisional decision.

Derived decision records are admitted only when their bytes reproduce from an
accepted review entry and its exact subject. Raw review evidence remains the
authority; these folds may be rerun after cloning or derived-state loss.
