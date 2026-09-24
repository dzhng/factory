# Working on Factory

Read the root README and the README of each package you change. Read
`SECURITY.md` before security-shaped decisions; it owns the trust model.

Keep this personal tool simple. Prefer deleting duplicated state and unused
machinery over adding guards, compatibility layers, or process artifacts.
Explain changed API contracts and schemas plainly.

## Verification

For behavior changes, demonstrate a failing test before the fix, then green.
Use the narrowest existing test while iterating. Extend existing journeys rather
than creating a new runner or committed report for every feature.

Tests that touch provider homes/configuration, hooks, `.factory`, or provider CLIs
run in the disposable Docker environment. Never mutate live developer settings
or take desktop focus. Mock external boundaries, not internal collaborators.

Use the real browser workbench for UI changes; preserve current baselines unless
the appearance intentionally changes. Review the diff and affected docs, then
run repository build, format, lint, types, tests, and relevant platform checks at
closeout. Exercise the installed CLI for release changes.

## Milestones

Commit each green checkpoint and push it to the active upstream branch.
