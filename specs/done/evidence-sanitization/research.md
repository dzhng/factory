# Evidence sanitization: research and boundary decisions

## Parsing configuration as data

[Node's dotenv specification](https://nodejs.org/api/environment_variables.html)
defines quoted and multiline values, comments, whitespace, and optional `export`.
There is no universal dotenv grammar. Use those semantics as the baseline for
Factory's pure parser; do not load values into the process environment or execute
interpolation. Tests must pin the supported syntax, including literal shell
substitutions. Retain qualifying values from every assignment, including duplicate
keys across files, because transcripts can contain any of them.

## Detection is heuristic

[Gitleaks](https://github.com/gitleaks/gitleaks) uses targeted rules and entropy
criteria rather than treating every hash as a credential. Factory should use
recognizable credential patterns and secret-labelled assignments, supplemented
by exact repository env values. This is research input, not a requirement to
install a scanner, copy its complete rule set, or contact credential providers.

Do not claim perfect secret detection. Encodings, credentials removed before
observation, unrecognized formats, and excluded discovery trees remain limits.
No secret dictionary, per-secret fingerprint, or credential validation request
belongs in this design.

## Identity constrains preparation order

Private raw bytes and portable evidence cannot share an identity after redaction.
The safe leaf bytes must exist before their references and parent manifests.
Raw Git race detection remains a separate fact: two source states can sanitize
identically without proving continuity. Accepted model submissions likewise need
preparation before their ledger and decision identities are derived; provider
final prose is not another publication channel.

Trigger/manifest-last publication makes earlier prefixes logically invisible,
not physically private. Unreferenced objects and temporary publication files can
still enter Git, so preparation must cover them too.

The relevant owners are the [capture package](../../../packages/capture/README.md),
[journal](../../../packages/runtime-journal/README.md),
[repository](../../../packages/repository/README.md),
[review planning](../../../packages/review-plan/README.md), and
[acceptance](../../../packages/review/README.md).

## Rejected shortcuts

Sanitizing only the review prompt leaves committed secrets intact. Sanitizing
only transcripts leaves source, patches, PR metadata, and response copies exposed.
Rewriting serialized records after hashing breaks their references. Blanket
hash removal breaks Git and Factory identities. Re-running sanitization during
crash recovery can conflict with an immutable prefix after env rotation.

The product was unlaunched when this boundary was introduced. The cutover needed
no compatibility readers, data migration, cleanup command, or Git-history rewrite.

## Independent draft synthesis

Two independent Codex drafts optimized fewest slices and risk-first sequencing;
one Claude draft optimized seam ownership. All found the raw-journal/public-hash
coupling and the duplicate response/ledger publication surface. Factory keeps
source identity and prepared recovery distinct rather than adding a general
publication transaction framework.

Accepted from the seam draft: keep ObjectRef's equality contract intact, explicitly
teach the reviewer about reduced evidence, and avoid adding public raw-payload
digests as redaction provenance. Rejected its final-writer byte mutation and
closure-only replay fallback: neither preserves the prepared graph's authority.
Also rejected globally skipping hash-shaped env values, admitting unscannable
binary bytes, and adding a common-word exception to the agreed env threshold.
Those narrow the requested protection. Structural exemptions belong to typed
fields, not to strings throughout a transcript.

The drafts suggested per-leaf tool budgets. Factory instead budgets a whole
recognized result across its text blocks: otherwise a many-block response can
still grow without the intended bound. This retains provider structure without
turning each array element into another full-size allowance.
