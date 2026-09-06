# Sanitized review evidence

Factory should preserve implementation reasoning without committing credentials
or pages of low-value tool output. Sanitization happens before portable evidence
is hashed or written, not just before the reviewer sees it.

## Next Agent Prompt

Status: all publication owners implemented; combined certification in progress. Last updated: 2026-09-07.

The active implementation goal includes both this spec and the
[choice-audit reviewer](../choice-audit-reviewer/README.md). Finish and verify
both before marking the goal complete. Typed submission tools, provider wiring,
and choice presentation are integrated. The remaining parallel work is the
installed native journey, whole-feature review, and final documentation.

Continue [installed certification](slices/05-certification.md), then run global
and supported-platform gates and archive both specs. Read the [contract](contract.md)
and `SECURITY.md`; this unlaunched cutover has no migration or compatibility work.
All repository, capture, review, action, GitHub, subject, and report callers use
prepared publication authority. Private recovery retains exact safe graphs, not
secret dictionaries. Merged types and owning Docker suites are green. The native
journey passes capture, first review, UI actions, unchanged no-op, and fresh-clone
reconstruction. Its second-review failure from objectless source omissions is
fixed; finish both-provider partial-output and PR coverage against that candidate.
Invoke write-tests before behavior changes and follow red/green in the owning
Docker environment. Do not inspect real secrets or alter live provider homes.

No active blocker remains. The warning is architectural: changing bytes inside
the existing low-level writer after references are computed breaks evidence
identity. Prepare leaf content first, then build the graph from its final refs.
Intermediate commits are implementation checkpoints, not a release or a claim
that all committable paths are protected. Do not publish an npm release until
the final journey is green.

- [x] [1 — Shared policy and safe discovery](slices/01-policy.md)
- [x] [2 — Sanitized code and PR observations](slices/02-observations.md)
- [x] [3 — Provider capture and durable replay](slices/03-capture.md)
- [ ] [4 — Review output, actions, and publication closure](slices/04-publication.md)
- [ ] [5 — Installed-CLI certification](slices/05-certification.md)
- [ ] Complete the complementary [choice-audit reviewer](../choice-audit-reviewer/README.md)

Commit and push each green slice to the active upstream branch. Update this
prompt and the owning slice with actual evidence, remaining work, and the exact
next pickup before ending every pass. Do not convert tests that could not run
into claimed verification. Once shipped, use close-spec to archive the rationale.

## Design map

The [contract](contract.md) owns policy, schemas, failure behavior, and identity.
The [choices ledger](choices.md) records decisions made during implementation.
The [research](research.md) records external sources and shortcuts ruled out by
the current architecture. Read those before making security-shaped decisions.

`policy → code/PR observations → capture/replay → publication closure → installed journey`

Each slice has a synthetic text report or CLI probe. There is no visual redesign,
new settings panel, public redaction command, or user setup step. Reports let the
user inspect retained reasoning, omission markers, and limitations without
exposing real secrets. Human feedback is non-blocking for reversible choices;
otherwise record the evidence-based verdict and continue.

## Single-owner invariants

- The sanitizer owns policy; adapters own provider structure, not copied regexes.
- The contract package owns transformed-evidence schemas, not parallel raw and
  sanitized public formats.
- The repository owns publication; callers prepare content before deriving
  identities. The writer must not secretly rewrite a completed graph.
- The existing journal and attempt owners own recoverable preparation. Do not
  add a second transaction service or a persisted credential dictionary.
- Git source identity, sanitized CAS identity, and review coverage are different
  facts. Preserve existing provenance and coverage authority while making
  evidence reduction explicit.

The end state should read as designed for sanitized evidence from the outset.
During the producer cuts, untouched writers are explicitly unfinished scope;
slice 4 closes all admission paths and removes any temporary raw-byte entry
points. There is no lasting feature flag or dual public representation.

## Verification discipline

Use named tests, then their file, then the owning workspace. All filesystem
tests touching a home, provider config, hooks, or `.factory` run in Docker;
pure string fixtures can run directly. A host-specific filesystem behavior may
also have a bounded native probe in a dedicated temporary directory, without
home, provider, hook, or `.factory` writes; this supplements rather than replaces
the Docker suite. Mock external `gh`/model boundaries,
not Factory's publication, discovery, hashing, or reconstruction owners.

Run review (shape, diff, docs) and the independent Codex review for substantive
implementation checkpoints. Update `SECURITY.md` and current package docs in
the same slice that changes their behavior; do not claim planned protection in
the current security model. At final closeout run repository-wide build, format,
lint, type, test, and platform gates once, plus the feature's installed journey.

## Scope decisions

The user selected sanitization of everything Factory generates that can enter
Git, not provider-owned source transcripts or arbitrary user source files. Tool
results are context; user/assistant reasoning remains untrimmed. Readable partial
evidence still deserves review. Legitimate structural hashes remain meaningful.
The product is unlaunched: no backward compatibility, migration, or history
rewrite is authorized or needed.

The parallel [choice-audit reviewer plan](../choice-audit-reviewer/README.md)
adds typed model submissions. Its draft events must use this same publication
boundary; implement that spec as part of this goal without creating a second
sanitizer or a fallback raw-response channel.
