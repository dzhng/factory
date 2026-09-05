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
automatic review, and review limits. Unknown
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
  associations/<observation-id>/batches/<batch-id>.json

pull-requests/github/<repository-key>/
  repository-mappings/<repository-id>/<observation-id>.json
```

The repository key is a digest of the lowercase GitHub hostname and GitHub's
stable repository node identity. Owner and repository names are locators, not
identity: renames keep one history, forks keep distinct identities, and equal
provider IDs on different GitHub Enterprise hosts remain distinct.
An observation attempt freezes the first provider-stable base identity it
receives. A later conflicting identity makes the attempt unavailable under that
first key; it never moves already-seen evidence into a last-seen repository.

An available observation freezes provider and PR identity, state, the facts
shared by two coherent metadata views, raw evidence, and the exact diff. Its
discriminator distinguishes complete commit/ref evidence from a readable
partial subject. A bounded commit prefix is labeled as a prefix, and deleted
fork/ref fields remain explicitly absent; neither can be used as negative
membership proof. Optional code capture records whether it was captured,
failed, or was not requested. Provider errors, races, malformed responses, and
missing foundational diff evidence are typed unavailable. Before GitHub reveals
its stable base repository identity, an unavailable attempt remains runtime-only;
Factory does not disguise a mutable owner/name locator as a durable repository
key. After identity is known, a durable unavailable record carries only that
base identity and nonempty raw metadata proof; it never promotes untrusted
state, head, or commit fields as exact.

Automatic evidence joins a validated Turn to the RepositoryObservation it
names. Exact head equality or membership in a complete PR commit set is the
only automatic gate. A provider-derived local-repository mapping can classify
the source as the PR base or a different repository; missing or conflicting
mappings leave classification unavailable without weakening the SHA proof.

An association freezes Session, PR observation, evidence kind (`commit`,
`head`, verified `code-state-continuity`, `manual`, or `invalidation`),
strength, relevant SHAs, repository-identity result, and source observation
IDs. Exact evidence must name nonempty SHA and source-observation proof. Manual
evidence is visibly asserted and carries its actor and reason; it is never
called verified. Invalidation is a new record associated with a later PR
observation and names the old evidence record instead of editing it. The later
observation's local time orders this proof. Association records become visible
only through an immutable completion batch that pins their hashes, sources,
timestamp, and policy. A crash may leave physical prefixes, but projections
ignore any record not named by a valid completed batch.

The same acquisition deadline covers provider calls and content-addressed
evidence writes. A write that finishes after its deadline can leave only an
unreferenced content object, which is inert because no observation or batch
marker names it.

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
Findings carry an explicit low, medium, high, or critical severity so advisory
results and opt-in enforcement use the same durable authority. Decision entries
also carry an explicit stable `decisionKey`, structured `assertion`,
`assert`/`remove`/`contradict` effect, and confidence. A reviewer may reuse a key
only when evidence establishes the same semantic decision. Missing output never
means removal.
`response.txt` preserves the reviewer response for inspection. Failed attempts
store a sanitized reason in the manifest; transient full logs remain runtime
state.

A coverage action accepts one named partial review and its exact limitations.
It settles only the trigger watermarks that review actually attempted and does
not mutate the review, triggers, or missing evidence inventory.

Every review manifest also keeps the canonical per-trigger selection ledger:
the exact Session, Turn, watermark, classification, reason, and limitations
seen by planning. A high watermark is therefore never interpreted as proof
that an earlier hole was reviewed. Complete reviews settle only a hole-free
prefix of fully verified inputs; readable partial evidence is remembered as
analyzed but remains unsettled until recovery or an exact coverage action.

The disposable review bundle mirrors each selected portable record at its
declared `.factory` path and includes the complete transitive object closure.
Its compact manifest names those files by relative path, digest, length, and
kind instead of duplicating rich evidence. Verification is rooted in directory
descriptors, enforces pinned limits, rejects foreign entries, and recomputes
the semantic subject fingerprint from the bundled observation. It does not
read the live checkout or Git metadata.

## Decisions

```text
decisions/observations/<decision-observation-id>.json
decisions/actions/<decision-action-id>.json
```

An observation references its originating review and validated decision entry.
Its explicit decision key is the only grouping authority; Factory never matches
summary prose. The structured assertion and effect have a canonical fingerprint
that excludes summary wording and confidence, so exact replays and material
changes are reproducible. A derived observation enters the fold only when its
exact bytes reproduce from the accepted review, entry, and subject record. Its
source records either an exact/inexact workspace
branch snapshot or an exact pull-request observation. Pull-request and
non-canonical workspace observations remain proposals. Only an exact workspace
snapshot whose branch equals the committed `canonicalBranch` is canonical.

Actions are discriminated append-only records. Confirm, reject, and dispute name
one exact observation; resolve names one dispute action; supersede names the
directional old and replacement observations. Dispute, resolve, and supersede
require an explanation. Each action names the previously accepted action head,
or null for the first action. Concurrent Git branches from the same head
therefore produce one deterministic winner after merge; the other branch and
its descendants remain stale diagnostics. Every request includes a
decision-view fingerprint
that commits to both the projection and its complete observation/action
history. The repository appends only while the exact observation and
action record set and configured canonical branch used for validation are still
current. An identical retry converges on the first immutable action and keeps
its first timestamp. Reviewers emit observations only; v1 actions require a
human actor.

The deterministic fold keeps canonical scope, analyzer confidence, exact
materiality, and human status separate. A first canonical assertion is current
but unconfirmed. An exact semantic replay is another unconfirmed observation;
different content under the same explicit key, removal, and contradiction are
high-priority pending supersessions. They do not replace the current assertion
until an explicit supersede action. An action changes only the exact observation
it names. Resolving a dispute closes that alert and restores the target's prior
human status; reject or supersede records a substantive outcome. Invalid
actions remain visible as
high-priority diagnostics instead of making the decision history unreadable.

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

Capture ordering is common to all linked worktrees. The runtime journal retains
the exact destination worktree and repository identity with each completion,
but it does not split authority into separate worktree journals. A Stop is
observed and published in its own worktree only after that checkout exposes the
same portable repository identity; an older linked branch without `.factory`
stays pending. A durable Stop claim freezes its exact Session generation, event
identities, and sequence cutoff until a verified immutable Turn completes it;
claims are fences, not expiring leases.

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
