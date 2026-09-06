# Factory

Factory is a local, open-source CLI that captures provider-native Codex and
Claude Code Session evidence beside the code it produced, reviews readable
evidence in isolated Docker containers even when the evidence is partial, and
keeps the resulting evidence, limitations, and decisions in ordinary Git.

The first release has no Factory account or hosted backend. Portable state is
stored as inspectable, versioned files under `.factory`; credentials, locks,
caches, and other machine state remain outside Git.

The [npm installation guide](scripts/npm-README.md) explains the packaged CLI
and explicit hook setup. [Release publishing](scripts/README.md) owns the
tag-to-package distribution contract.

The [v1 rationale](specs/done/factory-v1/README.md) records product principles,
trade-offs, and verification provenance. Its [public format](specs/done/factory-v1/format.md)
is separate so portable data does not depend on one package layout.

The [evidence sanitization rationale](specs/done/evidence-sanitization/README.md)
records the committable-data boundary and its verification evidence.
The complementary [choice-audit rationale](specs/done/choice-audit-reviewer/README.md)
explains cited, standalone judgments of agent-made choices.

The [security model](SECURITY.md) owns repository trust, credentials, container
isolation, and local interface policy. The implementation follows these ownership
boundaries:

- [CLI](packages/cli/README.md) composes commands and installation;
  [capture](packages/capture/README.md) adapts provider events and the
  [runtime journal](packages/runtime-journal/README.md) owns their durability.
- [Sanitization](packages/sanitization/README.md) owns the shared secret-matching
  and evidence-reduction policy used across portable publication.
- The [public contract](packages/contract/README.md) defines portable records;
  the [repository store](packages/repository/README.md) owns their writes and Git
  snapshots; [GitHub](packages/github/README.md) supplies optional PR observations.
- [Domain projections](packages/domain/README.md) interpret history;
  [review planning](packages/review-plan/README.md) freezes inputs;
  the [reviewer](packages/reviewer/README.md) owns Docker execution and
  [review acceptance](packages/review/README.md) publishes validated results.
- The [local interface](apps/web/README.md) presents repository projections;
  the [test harness](packages/test-harness/README.md) owns verification across
  process, browser, container, and release boundaries.
