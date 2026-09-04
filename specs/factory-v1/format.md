# `.factory` v1 file format

This document defines the portable, Git-visible format. Runtime SQLite, locks,
caches, temporary directories, provider homes, and machine paths are not part
of it.

The exported TypeScript schemas and runtime validators in
`packages/contract/src/index.ts` are the executable authority for exact field
sets and enums. This document owns their durable meaning; adding a public field
changes the format and must update both authorities together.

## Ownership

Factory v1 owns only:

```text
.factory/manifest.json
.factory/config.json
.factory/sessions/
.factory/repository-observations/
.factory/pull-requests/
.factory/review-triggers/
.factory/reviews/
.factory/decisions/
.factory/objects/
```

Unknown siblings are preserved. No recursive cleanup may target `.factory`
itself. `.factory/skills` is explicitly foreign.

## Encoding and identity

- Structured files use UTF-8 JSON with a final newline.
- JSONL envelopes use one canonical JSON value per line.
- Timestamps are UTC RFC 3339 strings.
- Durable record IDs are collision-resistant, sortable, and safe as one path
  segment.
- Object identities are lowercase SHA-256 of exact bytes.
- Paths captured from Git are represented losslessly as encoded bytes rather
  than assuming UTF-8.
- Ordering that affects hashes is explicitly sorted; filesystem enumeration
  order is never semantic.

## Root manifest

`.factory/manifest.json` is the first read boundary:

```json
{
  "schemaVersion": 1,
  "format": "factory-repository",
  "minimumReaderVersion": "0.1.0",
  "repositoryId": "repo_...",
  "createdAt": "2026-09-04T00:00:00Z"
}
```

`repositoryId` is portable identity, not a remote URL or host path. Clones and
forks initially retain it because Git history is the same trust domain. V1 does
not infer or migrate repository lineage.

## Repository configuration

`.factory/config.json` is the only ordinary mutable Factory file. It contains
schema-defined repository policy, including `canonicalBranch`, `reviewer`,
automatic review, decision confirmation policy, and review limits. Unknown
fields are preserved by read-modify-write operations.

`reviewer` is either `"auto"`, which defers provider selection until a review
is created, or an object selecting a provider and optional model and effort.
Review manifests always record the resolved reviewer object; they never store
`"auto"`.

## Sessions and Turns

```text
sessions/<provider>/<session-key>/
  identity.json
  turns/<stop-id>/
    manifest.json
    events.jsonl
    transcript.jsonl
  lifecycle/<event-id>.json
```

`identity.json` freezes provider, native session ID, capture generation,
repository ownership, and first observation. Later lifecycle facts are separate
immutable records.

A Turn manifest records:

- Session and Stop identities;
- captured and materialized timestamps;
- ordered event range and transcript observations;
- raw-object references for every provider payload;
- repository and branch observations;
- exact code-manifest and staged/unstaged patch references;
- known missing ranges, races, unavailable fields, and cross-repository facts;
- capture adapter and format versions; and
- the content inventory needed to verify the Turn independently.

`events.jsonl` and `transcript.jsonl` are inspectable envelopes. Each envelope
preserves ordering and references the exact raw bytes in the CAS; an adapter may
also include non-authoritative parsed fields. A later parser failure cannot make
the raw reference unreadable.

## Repository observations

`repository-observations/<observation-id>.json` records an exact Git and
filesystem observation. It includes repository-relative or encoded paths,
branch/detached state, HEAD, index identity, changed paths, worktree fingerprint,
code manifest, patches, limitations, and start/end state used to detect races.
Operational absolute paths are never stored here.

The `codeManifest` object is canonical JSON with schema version `1`, a
byte-sorted `entries` array, and an explicit `limitations` array. Each entry
uses the encoded Git path authority and records one Git-compatible mode:
ordinary file (`100644`), executable file (`100755`), symbolic link (`120000`),
or submodule pointer (`160000`). Files, symbolic-link payloads, and LFS pointer
files reference their exact bytes in the CAS. Submodules record only their Git
object identity. Factory never fetches submodule or LFS content implicitly.

Consumers load a code manifest through its object reference, not from an
already-parsed object supplied by an untrusted caller. Loading verifies the
reference role and media type, exact object digest and length, fatal UTF-8,
canonical original JSON bytes, and the runtime schema before reconstruction.

Workspace observations include tracked paths and non-ignored untracked paths,
except the complete `.factory` namespace. `.factory` evidence is inventoried by
the review bundle rather than recursively becoming code; this exclusion also
applies to foreign `.factory/skills` content. Ignored paths outside `.factory`
are excluded and reported as a limitation. Sparse tracked paths that are absent
from the worktree, unsupported filesystem entries, unsafe or
cyclic links, files over the measured limit, and any read race remain explicit
limitations; omission never means the missing bytes were observed. A
reconstruction starts in an empty directory outside the subject worktree's Git
metadata directory and its common Git directory, preserves path bytes and
supported modes, and refuses a manifest whose links could escape or cycle.
Materialization resolves every component relative to already-open directory
descriptors with no-follow semantics; path renames and symlink swaps cannot
redirect a write outside the bound destination inode. Descriptor-relative
inventories immediately before and after materialization require paths, entry
kinds, full file permission modes, lengths, content digests, symlink targets,
and writer-created filesystem identities to equal the manifest exactly. Final
hashing streams within the manifest's per-file and aggregate byte bounds. A
failed destination is disposable and may contain a partial manifest or a
concurrent foreign replacement. Factory never removes entries during failure
handling because POSIX has no portable identity-conditional unlink; the caller
must discard the entire destination without consuming it as a snapshot.

Observation never asks Git to compare live worktree content, because even
status-shaped commands can execute configured clean filters. Changed paths are
derived from byte-read files, index object identities, and the HEAD tree. Git
stdout and stderr are bounded, commands have a deadline, and retained file
bytes have per-file and aggregate bounds. Start/end sentinels domain-separate
refs, branch, local config, raw index, and byte-preserving worktree state;
readable paths are also checked individually against their post-capture state.

## Pull requests and associations

```text
pull-requests/github/<repository-key>/<number>/
  observations/<observation-id>.json
  associations/<observation-id>/<evidence-id>.json
```

An observation freezes provider identity, external PR identity, state, base,
head, commit set, timestamps, availability, and exact diff/code-manifest
references. Unavailable observations record typed reasons rather than partial
facts masquerading as exact.

An association freezes Session, PR observation, evidence kind (`commit`,
`head`, or verified `code-state-continuity`), strength, relevant SHAs,
repository-identity result, and source observation IDs. Invalidation is a new
record associated with a later PR observation.

## Review triggers

`review-triggers/<trigger-id>.json` records every Stop, its Session and Turn,
repository observation, evidence watermark, provider, creation time, and
materialization state. Review coverage is derived from review manifests and
acceptance actions; triggers are never edited to say `reviewed`.

## Reviews

```text
reviews/workspace/<review-id>/
  manifest.json
  ledger.json
  response.txt

reviews/pull-requests/github/<repository-key>/<number>/<review-id>/
  manifest.json
  ledger.json
  response.txt

reviews/coverage-actions/<action-id>.json
```

There is no workspace subject key. The immutable manifest contains the exact
branch/detached observation, head, code manifest, patches, Session watermarks,
trigger IDs, prior ledger, limitations, reviewer identity, version digests,
bundle hash, container-image digest, provider CLI version, model and effort,
effective reviewer settings, host platform, start/end timestamps, and
disposition.

Disposition is one of `complete`, `partial`, or `failed`:

- `complete` means every selected input was verified and reviewed;
- `partial` inventories every unavailable or excluded input; and
- `failed` means no meaningful semantic result was accepted.

`ledger.json` contains only validated semantic entries with evidence citations.
`response.txt` preserves the reviewer response for inspection. Failed attempts
store a sanitized reason in the manifest; transient full logs remain runtime
state.

A coverage action accepts one named partial review and its exact limitations.
It settles only the trigger watermarks that review actually attempted and does
not mutate the review, triggers, or missing evidence inventory.

## Decisions

```text
decisions/observations/<decision-observation-id>.json
decisions/actions/<decision-action-id>.json
```

An observation references its originating review entry and exact code subject.
It records canonical-branch scope separately from confidence or human status.
An action confirms, rejects, disputes, resolves, or supersedes one or more
observations and cites the acting review or local human action. Current
canonical decisions are a deterministic fold of these append-only records.

## Content-addressed objects

Objects live at:

```text
objects/sha256/<first-two-hex>/<remaining-hex>
```

Objects contain exact bytes and no sidecar authority. Manifests provide role,
media type, byte length, and hash. Verification streams bytes and checks length
and digest before use. Unreferenced committed objects are not silently deleted.

## Runtime companion

The Git common directory contains `factory-runtime`, including the transactional
journal, write locks, derived indexes, materialization staging directories,
Docker state, and update cache. Linked worktrees receive separately keyed
operational state inside that runtime root while sharing repository identity.

Capture ordering is common to all linked worktrees. The runtime journal may
retain per-worktree routing paths, but it does not split authority into separate
worktree journals. A durable Stop claim freezes its exact Session generation,
event identities, and sequence cutoff until a verified immutable Turn completes
it; claims are fences, not expiring leases.

Creating a claim grants one materializer execution authority. Concurrent
callers observe the durable claim without receiving that authority; crash
recovery explicitly resumes its frozen input. Completion is accepted only
through a repository capability that verifies the owned Turn path and exact
immutable bytes.

Runtime data may contain absolute paths needed to return to a worktree. It is
non-portable and non-authoritative. Factory must remain able to rebuild every
derived projection from `.factory` alone.

V1 requires the Git common directory and worktree to reside on the same
filesystem so create-only records can be staged outside `.factory` and
published atomically. Factory performs a read-only filesystem preflight before
`.factory` initialization or mutation, then treats `EXDEV` from the actual
publication as the authoritative refusal for unusual mount layouts. It never
falls back to a non-atomic write.
