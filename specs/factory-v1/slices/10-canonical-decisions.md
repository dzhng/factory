# 10 — Canonical decisions and append-only actions

Status: **implemented; automatic action authority and dispute-outcome semantics
remain explicit human checkpoints**

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

## Shipped boundary

Validated decision entries create deterministic observation projections whose
bytes must join back to the accepted review and exact subject. The pure fold
uses explicit keys and assertions, exact configured-branch scope, event-time
ordering, and exact-target append-only human actions. Repository compare-and-
append authority covers both the full decision record set and canonical branch;
recovery proves immutable equality rather than trusting an ID.

The runnable replay explains proposal, current, replay, change, removal,
contradiction, confirmation, rejection, dispute, resolution, and supersession
states. Predecessor-free transitions and stale historical replay targets stay
visible as high-priority diagnostics instead of entering states the action
schema cannot complete.
