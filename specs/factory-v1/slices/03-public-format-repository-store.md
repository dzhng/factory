# 03 — Public format and repository store

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
