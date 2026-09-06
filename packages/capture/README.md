# Capture

Capture is the provider boundary for Factory. It retains exact hook input in the
private runtime journal, then turns a frozen Stop claim into one portable Turn,
repository observation, and review trigger.

Planning is pure. Provider adapters prepare every retained message using the
shared sanitization policy and reduce recognized tool results without trimming
ordinary reasoning. Transcript completeness is assessed on original bytes.
Codex result classification follows its [provider response model](https://github.com/openai/codex/blob/rust-v0.144.0/codex-rs/protocol/src/models.rs):
function and custom-tool results can carry either text or structured content.
Their text blocks share one result budget; image and encrypted payloads become
explicit nontext omissions. Tool-call inputs and unknown record kinds do not
inherit result classification.
The private journal freezes the entire prepared graph before the repository
publishes any of it, with the trigger as its logical commit point. A crash may
leave an unreferenced safe prefix; recovery replays the frozen bytes even after
env values or provider transcripts change. A committed but damaged graph is
refused rather than silently rewritten.

Event positions belong to the shared repository journal. One Session's ordered
events may therefore have gaps occupied by another Session. The frozen claim
owns exact event membership during capture; the portable Turn preserves those
positions, range endpoints, and its ordered evidence-object inventory for every
later reader. A gap in global positions alone never means evidence was lost.

Provider adapters own classification, fail-open responses, and hook patch
plans. They do not write provider configuration or `.factory`; the CLI applies
provider patches and the repository remains the sole `.factory` writer.
The same adapters inspect hook semantics: exact, duplicate, and stale entries
are derived from recorded fingerprints, while edited Factory-like entries are
reported without becoming removal authority.

Provider CLI presence is also a bounded observation owned here. Version probes
have fixed arguments, deadlines, and output limits; absence or malformed output
stays a typed diagnostic and never changes hook ownership.

Transcript reads are bounded and descriptor-relative beneath the configured
provider home. Missing, racing, forged, or otherwise unsafe transcript input
produces a readable partial Turn instead of suppressing review.
