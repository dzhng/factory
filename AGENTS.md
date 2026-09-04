# Coding conventions and best practices

Follow the main project README in the repository root. It is the map to the
project's architecture and verification documentation.

If any folder you are working in contains a `README.md`, read it before
continuing—the READMEs are written for you.

## Security decisions

`SECURITY.md` is the canonical security model. Read it **before** deciding
anything security-shaped—credentials, repository trust, hooks, Docker mounts,
container networking, evidence visibility, or localhost exposure—and before
reporting a security finding in a design or review.

It settles most of these questions already. In particular, running a checked-out
repository is the repository trust decision, while the host and an ephemeral
reviewer container remain separate trust domains.

## Communicating with the user

The user is very technical but does not read the code day to day. Responding in
code or pointing at files is fine; introduce a component briefly before naming
its internals.

API seams and schemas are the most important things to surface. When work
touches an interface between components, lead with what that contract means and
how it changed.

## Testing changes

Before implementation work on behavior changes or bug fixes, invoke
[`write-tests`](.agents/skills/write-tests/SKILL.md) and follow its red/green
workflow. Use it for test additions or revisions too.

Any test that writes provider configuration, touches a home directory, installs
hooks, creates `.factory` data, or invokes Codex or Claude runs inside the
project's Docker test environment. Never mutate the developer's live provider
configuration while testing. Use mocks only at external boundaries.

### Run the narrowest runner that answers your question

The root `bun run test` is a closeout gate, not a feedback loop. While iterating,
start with one named test, then one test file, then the owning workspace. Use the
repository-wide gate once near handoff or release.

## Visual UI changes

For visual changes, use the real browser workbench and deterministic fixtures.
Use [`screenshot-critique`](.agents/skills/screenshot-critique/SKILL.md) for an
unprimed second opinion and
[`compare-screenshots`](.agents/skills/compare-screenshots/SKILL.md) whenever a
prior or reference image exists.

## Big changes end with their own release-shaped journey

A full spec or major feature should end with its own journey in
`packages/test-harness`. Exercise the installed CLI and real local boundaries;
do not treat a mocked path as release evidence. Run the repository-wide build,
format, lint, type, test, and platform gates once at closeout.

## Milestones

Commit each green implementation checkpoint as a focused change and push it to
the active upstream branch. Do not accumulate completed milestones only in a
local worktree.
