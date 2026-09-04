# Factory

Factory is a local, open-source CLI that records complete Codex and Claude Code
work beside the code that it produced, reviews that work in isolated Docker
containers, and keeps the resulting evidence and decisions in ordinary Git.

The first release has no Factory account or hosted backend. Portable state is
stored as inspectable, versioned files under `.factory`; credentials, locks,
caches, and other machine state remain outside Git.

The approved v1 product and implementation contract is in
[`specs/factory-v1/README.md`](specs/factory-v1/README.md). Its file format and
ordered [implementation slices](specs/factory-v1/slices/README.md) are specified
separately so the public format does not depend on one package layout.
