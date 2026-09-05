# Review acceptance

This package is the trust boundary between raw reviewer output and portable
review history. It admits semantic entries one at a time, resolves every
citation against the verified bundle inventory, derives disposition from the
accepted subset and known limitations, and asks the repository's sole writer
to publish the immutable result with its manifest last.

Provider output never chooses record identities, coverage, or disposition.
Malformed output can reduce authority to partial or failed, but it cannot turn
uncited model prose into a ledger fact. Container logs remain runtime-only.
Readable semantic prefixes survive timeout, cancellation, and malformed tails
as execution-partial reviews; no valid entry produces a failed review with a
closed sanitized reason and no ledger.

The domain package owns verified stored-review grouping, subject resolution,
coverage, and decision folds. This package uses those shared projections to
publish rebuildable decision observations and validate human actions. The
repository writer performs the final compare-and-append, so a concurrent
history or canonical-branch change becomes a stale request rather than an
action on unseen state.
