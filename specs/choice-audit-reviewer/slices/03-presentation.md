# 3 — Human-readable choice presentation

Depends on slice 1 and can run in parallel with slice 2.

Implementation checkpoint: the compact domain projection and production browser
ledger are implemented. [The visual report](../assets/presentation/README.md)
records red/green probes, deterministic baseline/candidate pixels, complete
wide/narrow states, and the unavailable-agent adversarial critique fallback.
An independent integration inspection is still required; no fresh-agent visual
verification is claimed. The existing responsive/action journey remains green.

## Contract unlocked

Make the choice ledger—not generic findings or raw provider response—the primary
review surface. A user should be able to judge an agent-made choice without
opening the transcript: see the scenario, gap, reach, verdict, confidence,
corrected/provisional decision where applicable, and evidence provenance.

## API seam

Domain owns a compact presentation projection derived from the durable audit
schema. The web app renders that projection and retains its narrow existing human
actions. Do not send raw bundle objects, MCP drafts, provider diagnostics, or a
second browser-only ledger shape. Review history summarizes audit completion;
the decision area presents choices grouped by verdict and ranked least-confident
first within each group, matching the audit-choices review order.

Start with one red projection/browser fixture for a needs-user choice whose
provisional call and reversal are readable without opening details. Add focused
states for unsound correction, sound acknowledgement, explicit removal, empty
audit, partial audit, long standalone scenarios, and canonical-branch priority.
Keep action validation and stale-action behavior unchanged.

## Visual checkpoint

Capture deterministic wide and narrow screenshots of the choice ledger. The
slice variable is information hierarchy: verdict, headline, and required action
must scan first; the full ELI5 scenario, gap, reach, and provenance must remain
available without becoming an undifferentiated wall. Compare the full decision
panel and narrow card stack against current baselines with `compare-screenshots`.
Generic site styling, session cards, and PR layout are out of scope.

Run `screenshot-critique` unprimed as the final visual check before acceptance.
Open the shots for a non-blocking human checkpoint, allow roughly five minutes
while other work continues, then record the evidence-based verdict and close the
shots if no feedback arrives.

## Must remain green and delegated choices

Localhost-only binding, compact browser data, confirm/reject/dispute/supersede
actions, responsive fixtures, and existing accessibility anchors remain green.
Delegate spacing and disclosure mechanics. Do not delegate field hierarchy,
verdict ordering, standalone readability, or removal of generic finding-oriented
copy. Review, audit choices, update handoff, commit, and push.
