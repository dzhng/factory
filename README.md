# Factory

Factory is a local, open-source CLI that captures provider-native Codex and
Claude Code Session evidence beside the code it produced, reviews readable
evidence in isolated Docker containers even when the evidence is partial, and
keeps the resulting evidence, limitations, and decisions in ordinary Git.

The first release has no Factory account or hosted backend. Portable state is
stored as inspectable, versioned files under `.factory`; credentials, locks,
caches, and other machine state remain outside Git.

The approved v1 product and implementation contract is in
[`specs/factory-v1/README.md`](specs/factory-v1/README.md). Its file format and
ordered [implementation slices](specs/factory-v1/slices/README.md) are specified
separately so the public format does not depend on one package layout.

The [security model](SECURITY.md) owns repository trust, credentials, container
isolation, and local interface policy. The implementation follows these ownership
boundaries:

- [CLI](packages/cli/README.md) composes commands and installation;
  [capture](packages/capture/README.md) adapts provider events and the
  [runtime journal](packages/runtime-journal/README.md) owns their durability.
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
