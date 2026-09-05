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
file ceiling bounds reads as well as retained bytes, including race checks.
Excluded files contribute metadata-only race fingerprints, not invented content
identities; admitted files still require exact bytes and stable metadata.
Changed paths assert verified differences only; excluded content remains unknown,
so their absence cannot prove a clean worktree. Its
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
The same descriptor-rooted primitive inventories already materialized trees
for bundle verification, so a pathname swap cannot hide an undeclared file or
redirect a read outside the verified root.

Native directory reads carry EOF and failure in their return value, not in
libc's thread-local `errno`: unrelated runtime work between native and JavaScript
execution can change that side channel. Bounded directory batches retain raw
filename bytes and descriptor ownership without adding a C-compiler dependency.

Capture publishes immutable record graphs through one repository-owned grouped
operation. The trigger is the logical commit point: interrupted create-only
prefixes are ignored by projections and converge byte-for-byte during recovery.
An absent owned record area is valid; a non-directory replacement is corruption,
not an empty projection.
Verified object and record reads are capabilities used by the runtime journal;
paths alone never prove that committed evidence exists.

Decision actions use the same sole-writer rule with compare-and-append
authority. The writer checks the exact decision record set and configured
canonical branch while holding mutation ownership, then creates one immutable
action. Semantic retries keep the first stored timestamp; changed authority is
reported separately from an immutable-path collision.

Repository verification reports the bytes occupied by Factory-owned ordinary
files as part of the same read-only traversal. Preserved foreign `.factory`
paths are excluded because Factory neither interprets nor claims their storage.
