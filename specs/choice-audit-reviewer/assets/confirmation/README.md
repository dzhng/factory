# Confirmation refers to the recorded choice

Target: a reader must distinguish supporting the recorded implementation choice
from adopting the reviewer's corrected or provisional recommendation. Confirmation
changes human support for the exact observation; it does not rewrite the assertion
or erase the reviewer's judgment.

The production button says **Confirm recorded choice**. No action schema, target,
or domain behavior changes. The browser checks click this button on both the
receipt-retention and payment-retry cards and verify the exact recorded observation
reaches the HTTP action callback.

## Visual comparison

The complete [before](before/) and [after](after/) capture sets contain identical
synthetic state, viewport, DPR, locale, timezone, browser image, and reduced-motion
settings. The label is the only production rendering change. Inspect the full
[wide ledger](after/ledger-full--wide.png), [narrow ledger](after/ledger-full--narrow.png),
and enlarged action crops [before](crops/confirmation-before--narrow-2x.png) and
[after](crops/confirmation-after--narrow-2x.png).

The comparison helper measured nonzero grayscale pixel mismatch on the unsound
card: 0.787% wide and 1.143% narrow. Full-ledger mismatch is 0.443% wide and 0.777%
narrow. These locate the changed text; they are not quality scores. History,
expanded evidence, removed-choice, and read-only captures remain byte-identical.
The longer label fits the existing action row without clipping or horizontal
overflow at either viewport.

## Verification

The focused browser assertion failed on the old label and passed on the candidate.
It preserves the exact action target for both needs-user and unsound choices.
The production HTTP suite and owning type, lint, and build checks pass. The
existing local-UI journey matches eight screenshots across twelve states after
updating only the wide canonical-choice baseline for the intentional text change.

An unprimed visual reviewer inspected all sixteen candidate captures and all four
enlarged action crops. Its high-confidence verdict was clean: the label is clearer,
stays on one line beside Reject and Dispute at both widths, and causes no overflow.
The integrating owner independently inspected the wide ledger, narrow unsound card,
and enlarged action crop and agreed. The candidate is less ambiguous than the
baseline, with no new layout defect. Long narrow cards remain the intentional
standalone-explanation tradeoff.
