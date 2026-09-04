# 10 — Canonical decisions and append-only actions

## Contract

Validated review entries create decision observations. Feature/PR observations
are proposals; observations from exact snapshots of the configured canonical
branch form the canonical view without implying human approval. Material
changes, removals, and contradictions create high-priority pending
supersessions. Confirm, reject, dispute, resolve, and supersede are append-only
actions; nothing rewrites an observation.

## API seam

```ts
foldDecisions(
  observations: readonly DecisionObservation[],
  actions: readonly DecisionAction[],
  canonicalBranch: string,
): DecisionView;

appendDecisionAction(input: DecisionActionInput): Promise<DecisionActionRef>;
```

The pure `domain` fold is the one read authority used by CLI review output and
the UI. `review` validates action requests and `repository` performs the append.
Canonical scope, confidence, materiality, and human status are distinct fields.

## Runnable artifact

`bun run lab:decision-replay` renders every fold step for feature proposal,
canonical observation, unchanged replay, changed/removal/contradiction,
confirmation, rejection, dispute, resolution, and supersession fixtures.

## Verification

- Shuffled filesystem enumeration and ordinary Git record interleaving produce
  the same fold.
- A committed canonical-branch override wins over later `gh` disagreement,
  which remains a diagnostic.
- Canonical observation never fabricates human confirmation.
- Actions reject stale/invalid targets and append exactly one schema-valid file.
- Runtime index deletion and rebuild preserve the exact view.
- If semantic identity/materiality cannot meet deterministic fixtures, require
  explicit decision keys or human linking; do not introduce fuzzy hidden
  grouping.

## Delegated decisions

Replay presentation and conservative fingerprint internals after fixtures fix
equivalence. Action meanings, canonical authority, priority rules, and
append-only behavior are not delegated.

## Must stay green

No Epic or inferred workstream appears. Branch scope is evidence, not identity.
Review output is accepted only after citation/schema validation.

## Human checkpoint and feedback

Review the fold explanation for one canonical change and one contradiction. If
the reason confirmation is required is not predictable, split materiality from
the core explicit-action fold before UI work.
