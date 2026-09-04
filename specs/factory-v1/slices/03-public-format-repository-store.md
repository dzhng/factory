# 03 — Public format and repository store

Status: **implemented; the exact Bun 1.3.14 Docker image and browser screenshot
critique are unavailable in the current environment**

## Contract

Freeze the exact v1 schemas and implement the only writer allowed under
`.factory`. Every read begins at `manifest.json`; a newer
`minimumReaderVersion` stops before parsing or mutation. The store preserves
unknown siblings and unknown config fields, verifies exact bytes by SHA-256 and
length, and never performs legacy import, compatibility reads, dual writes, or
data migration.

## API seam

```ts
type OwnedArea = "manifest" | "config" | "sessions" |
  "repository-observations" | "pull-requests" | "review-triggers" |
  "reviews" | "decisions" | "objects";
type OwnedPath = string & { readonly ownedPath: unique symbol };

interface RepositoryStore {
  putObject(bytes: AsyncIterable<Uint8Array>): Promise<ObjectRef>;
  createImmutable(path: OwnedPath, bytes: Uint8Array): Promise<RecordRef>;
  updateConfig(change: ConfigChange): Promise<void>;
  materializeObjectInventory(
    refs: readonly ObjectRef[], destinationRoot: string
  ): Promise<void>;
  verify(): Promise<RepositoryVerification>;
}
```

`contract` is the sole schema/owned-path authority; `repository` is the sole
writer. `.factory/skills` cannot be constructed as an `OwnedPath`.

## Runnable artifact

A fixture workbench renders valid, partial, corrupt, too-new, and
foreign-content repository trees and reconstructs selected CAS inventories into
fresh directories without `.git`.

## Verification

- Golden fixtures cover every public record, canonical JSON/newlines, stable
  ordering, encoded Git paths, IDs, limitation enums, and size fields.
- Corrupt, truncated, substituted, missing, path-traversal, prefix-collision,
  unsafe/cyclic link, and oversized objects are refused or typed as limitations.
- Concurrent identical creation converges; conflicting immutable creation fails.
- A too-new minimum reader stops before any mutation.
- Every command preserves `.factory/skills` and arbitrary foreign siblings
  byte-for-byte; config read-modify-write preserves unknown fields.
- Factory-generated metadata contains no absolute machine paths. Raw CAS objects
  are explicitly exempt because they preserve provider bytes.

## Delegated decisions

Schema-validation library, internal schema filenames, atomic temporary names,
and sortable-ID library. Public field meanings, canonical encoding, owned paths,
and incompatibility behavior are not delegated.

## Must stay green

Raw evidence is canonical, immutable records are create-only, unreferenced
objects are not silently pruned, and Factory never mutates Git state.

## Human checkpoint and feedback

Inspect the golden tree and independent verification report. If a field cannot
be produced deterministically or verified without runtime state, change
`format.md` now; do not hide that authority in a later package.

## Implementation evidence

`bun run lab:repository-store` runs the workbench in a network-disabled,
read-only Docker container and writes deterministic JSON/HTML evidence under
`specs/factory-v1/assets/repository-workbench`. It renders valid, partial,
corrupt, too-new, and foreign-content trees, then reconstructs selected CAS
objects into a fresh directory with no `.git` and verifies their exact hashes.

The contract test suite exercises every v1 immutable record path, canonical
JSON, lossless non-UTF-8 Git paths, time-sortable IDs, negative nested schema
cases, path traversal refusal, path/payload identity, and the manifest
compatibility stop. The Docker repository suite covers concurrent convergence
and config updates, conflicting immutable creation, config unknown-field
preservation, foreign and prefix-collision preservation, symlink refusal,
object substitution and streamed size limits, missing references, truncated
records, exact CAS path shape, cross-filesystem refusal, and compatibility
rechecks before mutation.

The HTML was generated and its data assertions passed. Docker ran the suite with
the locally available Bun 1.3.11 image; repeated pulls of the pinned Bun 1.3.14
image made no progress, while host-side formatting, types, lint, and builds use
1.3.14. Exact-image Docker certification therefore remains unavailable rather
than a pass. The required fresh-eyes PNG critique is also explicitly
unavailable: the in-app browser security policy blocked navigation to the local
report, and no alternate capture route was used.
