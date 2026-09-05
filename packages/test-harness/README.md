# Test harness

This package owns tests that cross machine or process boundaries: disposable
Docker environments, crash labs, provider fixtures, release-shaped journeys,
and sanitized evidence reports. Production packages expose the narrow seams;
the harness proves those seams against real boundary behavior.

Provider fixtures preserve raw bytes and provider-native vocabulary. They are
observations, not a shared provider schema. Empirical oracle evidence informs
Factory without becoming production behavior.

Provider credentials are never implicit. Authenticated journeys require
dedicated test inputs and must report unavailable authority rather than reuse a
developer's live provider home. Generated scratch reports stay outside the
repository unless a spec deliberately promotes them into its `assets/`; the
default lab output is written under the operating system's temporary directory.
The provider oracle is deliberately promoted into the Factory v1 spec because
it records the evidence used to shape the capture contract.

The governing capture contract and reslicing triggers live in the
[Factory v1 specification](../../specs/factory-v1/README.md). Credential and
container boundaries are owned by [`SECURITY.md`](../../SECURITY.md).

`bun run lab:capture-vertical` runs the built CLI in a networkless disposable
home, replays both provider fixtures, deletes the journal's derived index, and
promotes the rebuilt portable tree and diagnostic report into the Slice 06
evidence directory.

`bun run check:localhost-ui` exercises twelve deterministic browser states at
wide and narrow viewports, including partial coverage and decision actions,
and compares their stable screenshots. The CLI vertical separately opens a
real two-provider repository and proves the interface projection is rebuilt
from its portable records. A repository-backed action journey sends decision
and coverage requests through the same HTTP server and verifies that only
their two declared append-only directories gain files.
