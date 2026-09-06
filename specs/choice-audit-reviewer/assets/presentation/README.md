# Choice presentation checkpoint

Target: verdict, headline, and required action must scan first. A reader must
then be able to judge the scenario, missing direction, future reach, and evidence
without opening a transcript. Lifecycle and human confirmation must not be
confused with the analyzer's verdict.

## Evidence

The production HTTP server and browser assets were exercised in the existing
networkless Playwright Docker image, using synthetic domain presentation inputs.
The capture entry point is
[`run-choice-presentation.ts`](../../../../packages/test-harness/src/run-choice-presentation.ts).
Run it inside the local-UI Docker image with an output directory and `--assert`.
The existing `run-local-ui.ts --check` also exercises the twelve prior responsive
states, keyboard anchors, and decision/partial-coverage actions.

- [Wide comparison](comparison/ledger--wide-side-by-side.png),
  [narrow comparison](comparison/ledger--narrow-side-by-side.png).
- [Complete wide ledger](candidate/ledger-full--wide.png),
  [complete narrow ledger](candidate/ledger-full--narrow.png).
- [Wide audit history](candidate/audits--wide.png),
  [narrow audit history](candidate/audits--narrow.png).
- [Expanded evidence](candidate/provenance--narrow.png),
  [enlarged evidence crop](crops/provenance-2x.png).
- [Pixel metrics](comparison/visual-parity-diff.json).

The paired viewport captures use the same semantic choice fixtures, viewport,
DPR 1, locale, UTC timezone, reduced motion, and browser build. Ledger placement
and information hierarchy are the changed variables. Whole-panel captures have
different dimensions because the panel moved from a sidebar to the primary
full-width area; those are qualitative context, not fixed-size pixel pairs.
Audit history and expanded citation captures are additional candidate states.

The candidate differs from the baseline: grayscale pixel mismatch is 10.195%
wide and 14.461% narrow. Distance is 0.12799 wide and 0.19357 narrow; these are
distance measurements, not acceptance scores. The candidate viewport hashes
were checked against the exact inputs used by the comparison helper.

## Behavioral proof

The needs-user browser assertion failed on the original UI because the provisional
call and reversal were absent, then passed. A projection test pins the complete
explanation and compact citation shape. Reversing confidence sorting made its
ordering test fail; restoring least-confident-first passed. Hiding the empty-audit
rationale made the browser check fail, then pass after restoration.
Removing the per-card verdict marker also failed its browser assertion; restoring
the marker passed.
Independent code review found that missing canonical policy discarded readable
choices. Projection and browser regressions failed, then passed with unclassified
read-only cards and no action fingerprint or confirmation controls.

The candidate journey checks needs-user guidance, correction, sound choices,
explicit removal without mutation buttons, full scenarios/gaps/reach, verdict
order, an explained completed empty audit, partial limitations, literal untrusted
text, expanded citation provenance, and no horizontal overflow at either width.
Domain and HTTP tests preserve append-only action targets and stale-state refusal.
The focused domain/web suites pass 35 tests; domain, web, and test-harness
typechecks and focused lint pass. The existing browser journey matches eight
screenshots across twelve states. A second independent code review reported only
the CLI action test's old snapshot consumer, assigned to the integration owner;
no remaining finding was reported in this slice's owned code.

## Adversarial visual critique — agent unavailable fallback

A fresh-context reviewer could not be allocated: all four agent slots were in
use, and the parent received an agent-limit refusal. This is the
`screenshot-critique` skill's explicitly recorded self-critique fallback, **not an
unprimed-agent verification**. Independent integration inspection remains with
the parent agent.

The strongest visible case against each feature was considered before judging:

- **Primary hierarchy:** the wide ledger displaces session information and its
  large cards could dominate the page. The required actions now appear next to
  their choices instead of being absent; session and PR cards remain unchanged
  below. This displacement is the intended primary-review hierarchy.
- **Narrow guidance:** a complete card extends beyond one viewport, which could
  hide its rationale. The provisional call and reversal appear before the story;
  full-card captures show ordinary vertical scrolling, not clipping or truncation.
- **Correction:** the single unsound card leaves unused horizontal space. Its
  width preserves the same readable line length as neighboring cards; the red
  correction block stays distinct from the historical lifecycle badge.
- **Sound/removal:** a removed choice could look like a current recommendation
  because it remains in the sound group. The explicit removal banner and removed
  lifecycle are visible, and the browser verifies there are no mutation buttons.
- **Confidence/canonical priority:** several badges could compete with the
  headline. They occupy a compact top row, and the headline and required action
  remain the strongest reading sequence. Group/confidence order is also tested.
  Self-critique caught that a group heading scrolls away from later cards; every
  card now repeats its verdict in the top row.
- **Provenance:** full hashes are small and wrap on narrow screens. The enlarged
  crop shows the complete digest with no horizontal escape; it is deliberately
  secondary to the explanation and available through a native disclosure.
- **Empty/partial history:** both can show zero choices and could imply the same
  assurance. The complete empty audit displays its explicit rationale; partial
  and failed audits retain separate result badges and missing-evidence warnings.
- **Missing policy:** the [read-only narrow view](candidate/read-only--narrow.png)
  could imply ordinary confirmed decisions. Its prominent notice and per-card
  unclassified/read-only labels expose missing authority without invented status.

Provisional visual verdict: candidate is less wrong against the stated target.
No visible overlap, clipped text, or horizontal overflow was found.

The integrating parent inspected the wide comparison, wide and narrow ledger,
read-only view, narrow audit history, and enlarged provenance crop. The candidate
exposes the missing decision rationale and required action; the narrow history
distinguishes an explained empty audit from failed and partial work. No clipped
text or horizontal escape was visible. This is a separate integration inspection,
not an unprimed critique. The merged production browser gate matched all eight
screenshots across twelve states. The installed CLI action consumer was updated
to the compact grouped projection and its real append-only test passed.

Preview showed the wide ledger, narrow ledger, and audit history for approximately
six minutes while tests continued. No user feedback arrived; Preview was closed.
The final wide, narrow, and read-only captures were shown again during the
independent-review and regression-test closeout, then closed without feedback.
