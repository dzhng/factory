# Local repository interface

This app is a short-lived view over a freshly rebuilt repository projection.
It owns browser rendering and loopback HTTP policy, but receives no repository
path, store handle, runtime database, object reader, or generic mutation port.

Two narrow callbacks connect user intent to the review services that already
validate append-only decision and partial-coverage actions. Closing the CLI
closes this server; there is no daemon or hosted authority.
