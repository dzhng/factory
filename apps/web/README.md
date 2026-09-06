# Local repository interface

This app is a short-lived view over a freshly rebuilt repository projection.
It owns browser rendering and loopback HTTP policy, but receives no repository
path, store handle, runtime database, object reader, or generic mutation port.

Two narrow callbacks connect user intent to the review services that already
validate append-only decision and partial-coverage actions. Closing the CLI
closes this server; there is no daemon or hosted authority. The browser sees
compact presentation records and unresolved action identifiers, never raw
decision actions or repository storage objects. Repositories that cannot be
validated render an unavailable, read-only state.

The choice ledger is the primary review surface. Required corrections and
reversible provisional decisions stay visible alongside the scenario, gap, and
future reach; citation details may be disclosed without opening provider data.
Review history describes audit scope and completion, not raw submission text.
Verdict grouping and confidence order belong to the domain projection, while
human confirmation and lifecycle remain independent facts.
