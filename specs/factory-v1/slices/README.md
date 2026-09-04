# Factory v1 slices

Implement these in numeric order except that Slices 01 and 02 may run in
parallel after the initial workspace skeleton exists. Each slice is a committed
checkpoint. If a named reslicing trigger fires, stop downstream work, update the
master spec and `Next Agent Prompt`, and add the smallest slice that resolves
the new uncertainty.

| Slice | Outcome | Depends on |
|---|---|---|
| [01](01-provider-reference-oracle.md) | current provider and donor capture oracle | — |
| [02](02-reviewer-isolation-oracle.md) | read-only Docker auth/isolation proof | — |
| [03](03-public-format-repository-store.md) | public format and sole `.factory` writer | 01, 02 |
| [04](04-runtime-journal.md) | durable hook journal | 03 |
| [05](05-git-observation.md) | non-mutating exact code observation | 03 |
| [06](06-capture-vertical.md) | init/install through immutable Turn | 04, 05 |
| [07](07-pr-observation-association.md) | optional PR observation and exact associations | 06 |
| [08](08-review-planning-bundles.md) | deterministic incremental/partial bundle | 07 |
| [09](09-review-execution.md) | isolated immutable review result | 02, 08 |
| [10](10-canonical-decisions.md) | append-only canonical decision view | 09 |
| [11](11-localhost-ui.md) | inspect and confirm through `factory open` | 10 |
| [12](12-release-install-upgrade.md) | release-shaped macOS/Linux proof | 11 |

The standing review, security, visual, and closeout gates live in the master
[README](../README.md#standing-review-map) and apply even when a slice does not
repeat them.
