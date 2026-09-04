# 06 — Initialization, hooks, and immutable Turn vertical

## Contract

`factory configure`, `factory init`, `factory install`, `factory uninstall`,
`factory capture`, and capture-related `factory doctor` behavior work through a
real Docker-isolated user home and repository. A real provider Stop flows from a
direct global hook through the durable journal into one immutable per-Stop Turn,
repository observation, and trigger. Sessions enter `.factory` only after that
materialization succeeds; failed materialization leaves recoverable runtime
evidence. A crash may leave immutable physical prefix files, but no partial
Session is visible in the trigger-committed repository projection.

## API seam

```ts
interface CaptureAdapter {
  classify(raw: Uint8Array): CaptureEnvelope;
  providerResponse(result: CaptureResult): Uint8Array;
  reconcileHooks(existing: Uint8Array | undefined, executable: string): HookPatch;
}

planTurn(input: StopMaterializationInput): TurnWritePlan | PlanRefusal;
executeTurn(plan: TurnWritePlan, store: RepositoryStore): Promise<TurnRef>;
reduceRepository(records: RepositoryRecords): RepositoryProjection;
```

Planning is pure; execution publishes deterministic immutable records with the
trigger last as the logical commit point for one Turn.
The first initialized repository observed owns the native Session.

## Runnable artifact

In Docker, initialize a repository, install both providers, replay one Codex and
one Claude Turn, then run `factory doctor`. The artifact is the inspectable
`.factory` tree plus a rebuild report produced after deleting runtime indexes.

## Verification

- Explicit init is default; global auto-init requires opt-in and the plaintext
  evidence warning. Config precedence is flags > repo > global > defaults.
- Canonical branch suggestion uses authenticated `gh`, then remote HEAD, then
  `main`/`master`, then explicit input; committed override remains authoritative.
- Hook reconciliation preserves unknown fields and foreign hooks, fingerprints
  only owned entries, converges duplicates, and recovers install/uninstall
  crashes.
- Repeated Stop, continuing Session, transcript lag, SessionEnd recovery,
  unresolved `.factory` conflict, cross-repository activity, and branch switch
  retain raw evidence and correct limitations.
- Promotion is object-first and logically atomic; only a complete trigger-linked
  graph enters the projection. Runtime recovery converges interrupted prefixes
  later through hooks or explicit `doctor --repair`.

## Delegated decisions

Terminal copy, progress presentation, internal adapter filenames, and runtime
index layout. Public command names, init default, config precedence, canonical
branch authority, ownership, and per-Stop immutability are fixed.

## Must stay green

No provider plugin path, Factory trust registry, secret-redaction claim, Epic,
branch identity, Git mutation, or host-home test mutation appears.

## Human checkpoint and feedback

Inspect one materialized Turn per provider and hook/config diagnostics. If the
per-Stop layout is unreadable, lost capture is not diagnosable, or installed
hooks interfere with foreign config, revise this slice before PR work.
