# Synthetic choice-audit checkpoint

This is a fictional acceptance fixture, not a claim about Factory's implementation.
Each entry cites the synthetic exact object: SHA-256 `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
1 byte, `text/plain`, role `synthetic-evidence`. Acceptance sorts this report.

## Needs-user · low confidence — Keep review hosting in the existing region

When hosted review deployment was configured, a customer in another region starts
a review. Using the existing region keeps deployment simple but may increase
latency and place their data outside their preferred location. A deployment near
that customer changes cost and data location.

The request did not specify data location or the acceptable cost of another
deployment. Future hosted customers inherit this data-location and latency
decision. Customer geography, budget, and data-location preferences belong to
the user. Provisional call: use the existing region for synthetic traffic
temporarily. Reversal: select and deploy the agreed region before admitting
customer traffic.

## Unsound · high confidence — Retry failed reviews without a deadline

When transient reviewer failures were handled, the model service is unavailable
and a review retries forever. The command never returns and occupies the review
slot. A finite deadline would preserve the captured evidence and let the developer
retry after the service recovers.

The request asked for retrying transient errors but did not set a stopping
condition. Every unattended review can otherwise remain active indefinitely.
Retries must stop when they cannot make progress. Corrected decision: every retry
sequence must have a finite deadline.

## Sound · high confidence — Repository owns durable writes

When durable review publication was implemented, a review finishes and publishes
several related records. The repository writer makes the manifest visible last,
so a crash cannot expose half a review. Separate writers would each need to
coordinate that recovery rule.

The task required durable reviews without assigning one publication owner.
New analyzers and providers must publish through the repository boundary.
One publication owner gives every caller the same recovery guarantee.
