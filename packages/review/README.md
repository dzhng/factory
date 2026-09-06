# Review acceptance

This package is the trust boundary between typed audit submissions and portable
review history. It admits semantic entries one at a time, resolves every
citation against the verified bundle inventory, derives disposition from the
accepted subset and known limitations, and asks the repository's sole writer
to publish the immutable result with its manifest last.

Provider final text is private diagnostic output, never semantic authority.
Validated canonical submission events never choose record identities, coverage, or disposition.
Malformed output can reduce authority to partial or failed, but it cannot turn
uncited model prose into a ledger fact. Container logs remain runtime-only.
Readable semantic prefixes survive timeout, cancellation, and malformed tails
as execution-partial reviews. Without a valid choice or cited scope summary,
acceptance produces a failed review with a closed reason and no ledger. A
complete audit requires an explicit finish; an empty completed audit also needs
a cited explanation of why no undeclared choice was found.

The contract-owned draft seam admits bounded choice, summary, and finish events. Exact retries
are idempotent; conflicting reuse of a choice key retains the first submission
and makes the review partial. Citations must match the full verified object
reference, not just its digest. Rejected events never enter portable history.

The domain package owns verified stored-review grouping, subject resolution,
coverage, and decision folds. This package uses those shared projections to
publish rebuildable decision observations and validate human actions. The
repository writer performs the final compare-and-append, so a concurrent
history or canonical-branch change becomes a stale request rather than an
action on unseen state.
