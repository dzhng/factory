# Localhost UI visual review

The stable capture set covers four evidence-heavy states at 1440×1000 and
390×844. The browser lab also exercises eight additional non-captured states,
including empty, corrupt-data, upgrade-required, detached-HEAD, and unavailable
GitHub observations.

## Acceptance

- `bun run check:localhost-ui` reproduced all eight PNGs byte-for-byte across
  twelve scenarios.
- Browser assertions verified named landmarks, exact-versus-ambiguous PR copy,
  partial review copy, canonical decision states, literal rendering of hostile
  repository text, both action intents, keyboard skip navigation in a clean
  page, and absence of horizontal overflow.
- A repository-backed CLI journey sent decision and partial-coverage actions
  through the real loopback server. Existing evidence remained byte-identical;
  only the declared decision-action and coverage-action directories gained one
  immutable record each.
- Image telemetry found no transparent or empty frames. Candidate edge density
  remained between roughly 0.12 and 0.22; the increased contrast and edge energy
  match the deliberate typography, navigation, and action-hierarchy changes.
- A final fresh, unprimed screenshot critique found no High issues and accepted
  the responsive checkpoint. In particular, no clipping, overlap, or truncation
  was visible at 390px.

## Changes driven by critique

The first critique exposed clipped mobile navigation, unlabeled duplicate state
badges, misleading coverage reassurance, weak compact-text contrast, identical
decision actions, non-actionable PR URLs, oversized empty states, and incorrect
singular grammar. The accepted captures use an intentional mobile navigation
grid, dimension-qualified badges, honest coverage copy, safer action hierarchy,
clickable PR links, compact empty states, and singular-aware counts.

Follow-up critique also led to explicit append-only consequences beside partial
coverage and decision replacement actions. Review identifiers are shortened for
scanning without becoming authority-bearing UI data.

## Accepted limitations

- The replacement action remains visually prominent because it changes the
  current canonical selection. Its neighboring explanation distinguishes it
  from confirming an observation, and the server still applies stale-state
  protection before recording either append-only action.
- Compact decision controls are below an ideal touch-first target size. This is
  a short-lived localhost developer interface rather than a mobile-first app,
  and the controls remain separated, legible, and free of overlap at 390px.
- Focused captures intentionally scroll to the panel under review; some wide
  frames retain a small amount of neighboring context and some narrow frames end
  within a longer card.
