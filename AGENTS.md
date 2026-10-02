# Working in this repo

Read [`README.md`](README.md) first: what the product is, how the repo fits together, and where each concern lives. Then read the readme of each package you change. Active plans live with their specs, and each one says what to do next. The readmes are written for you.

These are the principles. Commands, flags and paths live with the code that owns them: the readmes, the manifests, and each tool's own usage text.

## Talking to the user

The user is very technical but doesn't read the code day to day. Pointing at code is fine; introduce a variable, function or module briefly the first time you mention it.

Lead with contracts. When work touches an interface between components (a command, a portable record format, a provider event, a module boundary), say what the contract looks like and how it changed before anything else.

Answer routine questions from the evidence. Ask the user only when the answer changes a decision that matters and can't be settled any other way.

## Proving a change

Optimize for iteration speed. The measure is the time to feedback you can trust, not the amount of process you ran.

Run the narrowest check that answers your question: one test, then one file, then one package. That is the proof for everyday work, including a commit, a merge and a push.

**The full gates are for milestones only.** Running everything is slow and saturates the machine, so it happens at a milestone the plan names in advance (a spec's stated checkpoint, a release) and once when a spec is closed. It is not a step before each commit, merge or push, and never a feedback loop. An agent working on one piece of a plan does not run it; whoever integrates the plan does, at the milestone.

Between milestones, a change is checked by what it can move: its own tests and the output it touches. A failure found later at a milestone is fixed then; that is cheaper than gating every step.

Every expensive run must answer a question a cheaper one can't. Container reviews, browser journeys and checks of the installed command are the expensive runs here; do only the ones a change can move. A release change is proved on the installed command. Reuse a result that is still valid, and rerun only what a change could have invalidated. Docs and data that no code reads need no run at all.

Write the test first. Before changing behaviour or fixing a bug, invoke [`write-tests`](.agents/skills/write-tests/SKILL.md) and show the test failing before the fix. Test what the product does and how it fails, not how the code is shaped.

Extend an existing journey before creating a new runner or a committed report for a feature. Mock external boundaries, not internal collaborators.

Tests that touch a provider's home or configuration, hooks, portable state or a provider's command line run in the disposable container. Never change live developer settings or take desktop focus.

Never loosen a requirement to make a check pass. A narrow pass proves a narrow claim: say what you verified, what you assumed and what is unfinished.

Commit each green checkpoint and push it to the active upstream branch.

Don't wait on a long run. Start it in the background and keep working. Give it a visible sign of progress and a point where you stop, and never repeat a failure unchanged.

## What the user sees

Look at the actual output. A passing check is not evidence that something reads well to the person in front of it. Use the real browser workbench for interface changes, and keep current baselines unless the appearance is meant to change.

For any visual change:

- get an unprimed second opinion with [`screenshot-critique`](.agents/skills/screenshot-critique/SKILL.md);
- judge before against after with [`compare-screenshots`](.agents/skills/compare-screenshots/SKILL.md);
- show the user with [`preview-shots`](.agents/skills/preview-shots/SKILL.md).

## Product boundary

This is a personal, local tool, and it stays simple.

Portable state is inspectable, versioned files in ordinary Git. Credentials, locks, caches and other machine state stay outside it.

[`SECURITY.md`](SECURITY.md) owns the trust model. Read it before any security-shaped decision.

## One owner per concept

Use what the repo already chose before writing your own. Find the existing owner of a concept before creating another.

Prefer deleting duplicated state and unused machinery to adding guards, compatibility layers or process artifacts. When something replaces an old mechanism, delete the old one. When a change exposes a duplicate or a stale owner, invoke [`refactor-clean`](.agents/skills/refactor-clean/SKILL.md).

## Parallel work stays cheap

Every parallel checkout is a full copy, and installed dependencies and build output multiply with each one.

- Share what doesn't change between checkouts. Don't make another copy.
- Never share build output between checkouts whose sources differ. They overwrite each other's builds, and the symptom is an error from someone else's change.
- Remove a checkout and its build output when its branch is merged.

## Skills

Skills hold the procedures behind these principles. Load the one that covers your work before you start. Keep them current: when a pass learns a lesson (a gotcha, a pattern that paid off, a rejected approach), add it to the owning skill in the same commit, following [`write-skills`](.agents/skills/write-skills/SKILL.md).

Before changing this file, invoke [`audit-agents`](.agents/skills/audit-agents/SKILL.md).
