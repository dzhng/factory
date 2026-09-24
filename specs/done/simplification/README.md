# Personal-tool simplicity

Factory persists facts, not copies of projections. Accepted review ledgers own
decision observations; human actions refer to their stable derived identities.
There is no second observation store or repair phase to keep synchronized.
[Decision projections](../../../packages/domain/README.md) and
[review acceptance](../../../packages/review/README.md) own that contract.

Checks belong at boundaries that can change an outcome. A verified bundle retains
its metadata; execution verifies the private snapshot before credentials are used
and the container verifies it on entry. Later changes to the disposable original
do not invalidate a completed review. See the [reviewer boundary](../../../packages/reviewer/README.md).

The [journal](../../../packages/runtime-journal/README.md) uses SQLite transactions
and scoped claim/preparation checks rather than auditing all history on every
hook. Recovery has bounded individual work and a fixed starting cutoff, not a
lifetime capture quota. The private object store remains: replacing its existing
crash-durable byte publication would be a separate storage redesign, not a free
simplification. Two derived indexes support pending-work queries; no second
storage mode or migration service is introduced.

Installation and upgrades remain supported. [Release verification](../../../scripts/README.md)
checks artifact identity and integrity, not license prose or historical string
blacklists. Ordinary notices and the archive shape remain consumable by existing
standalone upgraders; changing that shape would violate the retained upgrade
contract. Platform tar owns archive construction.

The [test harness](../../../packages/test-harness/README.md) owns live fixtures and
current browser baselines. Historical reports and duplicate generic agent skills
are not runtime or test dependencies. Browser scenarios share one runner; CLI and
PR journeys remain separate because their behavioral contracts differ. Installed
CLI verification uses HTTP and does not need a browser image. Reuse these tests
rather than generating a new permanent runner or report for every change.
