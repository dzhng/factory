# Test harness

This package owns tests that cross machine or process boundaries: disposable
Docker environments, crash labs, provider fixtures, release-shaped journeys,
and sanitized evidence reports. Production packages expose the narrow seams;
the harness proves those seams against real boundary behavior.

Provider fixtures preserve raw bytes and provider-native vocabulary. They are
observations, not a shared provider schema. Empirical oracle evidence informs
Factory without becoming production behavior.

The npm install journey accepts the actual packed tarball and exercises an
offline global install in disposable Docker state. It requires no Bun on the
consumer path and does not enable hooks in the developer's provider homes.
The opt-in [npm upgrade journey](src/run-npm-upgrade.ts) uses a candidate compiled
with an older version and the real npm registry to prove manual and startup
replacement in disposable global prefixes. Its network authority is separate
from the deterministic offline gates.

The [authenticated capture certificate](../../specs/done/factory-v1/assets/live-capture/README.md)
separates real lifecycle callbacks from fixture replay and model-only review
authority. Its test-only image enables hooks and persistence in disposable
provider homes while reusing the production attempt and Docker owners. Its
output is never accepted as semantic review history.

Release certification uses the same provider-owned CLI logins that production
automatically discovers. The disposable journey exposes only the selected
credential to each packaged review; it does not copy a developer's provider home
into the fixture. On macOS it passes the validated login Keychain path to the
packaged CLI, which keeps token extraction inside its own review-attempt cleanup
boundary. If both CLIs are not already authenticated, the report records
real-provider authority as unavailable instead of simulating a pass. Generated
scratch reports stay outside the repository unless a spec deliberately promotes
them into its `assets/`; the default lab output is written under the operating
system's temporary directory. The provider oracle is deliberately promoted into
the Factory v1 spec because it records the evidence used to shape the capture
contract.

`bun run release:verify -- --version <version>` builds from a clean committed
checkout, verifies the resulting archive through the public release boundary,
and executes that exact native binary in a disposable home and repository. The
journey covers installation, both provider capture adapters, isolated review,
one localhost decision action, diagnostics, same-artifact upgrade, and
uninstallation. Its report distinguishes deterministic fixture authority from
unavailable real-provider credentials and GitHub release attestation; neither
is converted into a simulated pass.

Incremental certification resumes a captured Session after another provider has
used the shared journal. It checks exact new-Stop coverage and delivery of the
accepted prior ledger, then repeats the unchanged review with Docker trapped.
The no-op must reuse the same immutable review without reaching the provider
execution boundary; a complete disposition alone cannot establish that claim.

When both local CLIs are logged in, the same command automatically adds one
production-image review from each provider:

```sh
bun run release:verify -- --version <version>
```

Certification is all-or-nothing: it forces both packaged production-path reviews
when both logins are available, otherwise it runs the deterministic journey and
reports the missing authority. An immutable image may be supplied as a controlled
test override; the shipped digest and product model defaults apply otherwise.

The capture rationale and evidence provenance live in the
[Factory v1 record](../../specs/done/factory-v1/README.md). Credential and
container boundaries are owned by [`SECURITY.md`](../../SECURITY.md).

`bun run lab:capture-vertical` runs the built CLI in a networkless disposable
home, replays both provider fixtures, deletes the journal's derived index, and
promotes the rebuilt portable tree and diagnostic report into the archived
capture-vertical evidence directory.

`bun run check:localhost-ui` exercises twelve deterministic browser states at
wide and narrow viewports, including partial coverage and decision actions,
and compares their stable screenshots. The CLI vertical separately opens a
real two-provider repository and proves the interface projection is rebuilt
from its portable records. A repository-backed action journey sends decision
and coverage requests through the same HTTP server and verifies that only
their two declared append-only directories gain files.
