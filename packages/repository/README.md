# Repository store

This package is Factory's only writer under `.factory`. It checks the root
manifest before any broader read or mutation, writes immutable records through
atomic create-only operations, and preserves content it does not own.

Callers provide contract-owned paths rather than filesystem strings. Runtime
state remains outside this boundary; object and record verification must be
reproducible from the committed tree alone.

The Git observer reads a checkout through a fixed read-only command vocabulary
and byte-preserving filesystem operations. It derives worktree changes from
raw bytes and index identities instead of asking Git to inspect live files,
because status-shaped commands can execute configured clean filters. Git
stdout and stderr are bounded, and every command has a deadline. Its
object-store seam lets capture finish the race sentinel before publishing
anything under `.factory`. The public `CodeManifest` in `@factory/contract` is
the reconstruction authority; the observer does not invent a second path or
mode format. Reconstruction writes relative to verified directory descriptors,
so concurrent destination-path swaps cannot widen its filesystem authority. It
inventories that bound directory before and after writing, rejects any tree
that is not exactly the manifest, and bounds final content hashing by the
manifest's per-file and aggregate byte counts. A failed destination is
disposable: Factory does not remove any pathname because POSIX cannot make an
identity check and unlink atomic against a concurrent replacement. Observation
remains importable without Bun FFI. Reconstruction reports an explicit
capability error unless it can load the supported native descriptor backend.
