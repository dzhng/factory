# Choice-audit decisions

Review these first: giving the ledger the primary screen area, selecting one
failure verdict rather than a threshold, and describing conditional tool fields
instead of advertising conditional schemas. All surviving choices are judged
sound; medium confidence means a reasonable owner could prefer the alternative.

## Sound

### Give standalone choices the primary screen area

Confidence: medium.

A reader deciding whether to retain payment receipts for a year needs the
reasoning, provisional retention period, and reversal instructions together.
Factory places the choice ledger across the page above the Session and pull-request
panels, with two cards across on wide screens and one on narrow screens. A sidebar
would leave more Session evidence above the fold, but squeeze these explanations
or require readers to open each one.

Gap: making choices the primary task did not determine how much screen area to
give them. Reach: future additions must preserve uninterrupted reading of the
decision, even at the cost of pushing supporting evidence farther down the page.
Verdict: sound because judging the choice, not navigating its source transcript,
is this screen's main task; the space tradeoff remains a product preference.

### Select one failure verdict, not a severity threshold

Confidence: medium.

A team wants CI to fail when the reviewer finds an unsound decision. With
`--fail-on unsound`, a needs-user choice does not fail that command: needing the
owner to select a retention policy is different from choosing a demonstrably
wrong policy. Conversely, `--fail-on needs-user` does not fail merely for an
unsound choice. A ranked threshold would silently decide which kind of judgment
includes the other; a multi-verdict selector would add a broader policy surface.

Gap: removing generic severity levels left command-line enforcement unspecified.
Reach: automation selects exactly the judgment it wants to enforce, rather than
inheriting an ordering between correctness and user authority. Verdict: sound
because the two meanings stay separate, although callers wanting either verdict
to fail must express that policy outside this single selector.

### Describe conditional tool fields and enforce them on submission

Confidence: medium.

A model submits an unsound choice without explaining the corrected decision.
Factory's submission server rejects it with a fixed, actionable message, allowing
the model to retry. The tool's advertised JSON Schema describes a flat object;
field descriptions explain verdict-dependent requirements. The pinned Claude
client drops the tool when the advertised schema uses conditional clauses.
Separate tools for each verdict would avoid that limitation but multiply the
agreed submission interface.

Gap: the tool contract did not settle client-specific schema expressiveness.
Reach: new conditional fields need both readable descriptions and authoritative
runtime validation. Clients cannot discover every cross-field rule mechanically.
Verdict: sound because interoperability weakens the advertised description, not
the values Factory accepts; the shared validator remains the authority.

### Keep evidence handles inside the verified bundle manifest

Confidence: medium.

A model cites a captured file by submitting `e1` instead of copying its digest,
size, media type, and role. The bundle manifest—the immutable description of the
review input—contains a table mapping that short handle to the full object
reference. The server expands the handle, and durable citations retain the exact
reference. Another bundle can assign `e1` to a different object; the handle is
never a cross-review identity.

Gap: the required deterministic evidence index had no chosen representation.
Reach: the manifest contains a bounded duplicate of its reference inventory.
A separate index file would need its own publication and digest binding, while
implicit numbering would make every client recreate the sorting rule. Verdict:
sound because the existing verified manifest binds both inventory and lookup
without another authoritative artifact.

### Disable Codex web search during bundle-only review

Confidence: medium.

A reviewer encounters a library name in the captured implementation. Codex's
built-in web search is disabled, so the review cannot quietly use a current web
page as if it were captured evidence. The container still has network access for
the model service; this switch is a tool restriction, not a network-isolation
claim. Leaving search enabled could help research, but its results would have no
exact citation in this review's immutable bundle.

Gap: requiring bundle citations did not choose the provider's search setting.
Reach: external research needs an explicit capture-and-citation path before it
can support this analyzer. Verdict: sound because the reviewer judges the history
Factory supplied, rather than adding a second, mutable evidence source.

### Copy the complete explanation into derived decision observations

Confidence: medium.

After accepting a review about receipt retention, Factory creates a decision
observation: a rebuildable record used to combine that choice with later reviews
and human actions. It includes the scenario, gap, reach, judgment, citations, and
corrected or provisional decision, not just the underlying assertion. The browser
can then explain the decision from the history projection without resolving its
source review again for every field.

Gap: verdict-aware history did not specify how much explanation the derived
record should carry. Reach: records are larger and repeat accepted prose, but
their complete bytes must reproduce from the authoritative review and subject.
A reference-only record would save duplication while moving those joins into
every reader. Verdict: sound because duplication is checked derivation, not a
second independently editable judgment.

### Use closed Claude configuration sources instead of safe mode

Confidence: high.

Factory starts Claude with its native login and the Factory submission server.
Claude's safe mode suppresses even that explicitly configured server, making a
typed audit impossible. Factory uses restricted mode, empty setting sources,
strict MCP configuration—the explicit list of tool servers—and read/submission
tool permissions inside the isolated container. Ordinary user settings could
activate unrelated hooks or tools; bare mode would lose native login support.

Gap: strict tool authority did not specify how the provider's modes interact
with explicit servers and authentication. Reach: provider-mode behavior remains
part of this integration's contract; these switches supplement the container
boundary, not replace it. Verdict: sound because closed configuration sources
retain the required login and tools without importing a user configuration home
or broadening host access.

### Use the submission journal itself as the lock target

Confidence: high.

Two submission-server processes can overlap after a retry. They acquire the same
operating-system lock on the journal file, so the second reads the first's event
before deciding whether to append. An exact retry succeeds without a duplicate.
The file is never replaced, and process death releases the lock automatically.
A separate lock file would introduce another artifact and cleanup lifecycle.

```text
lock the journal file
read and validate existing events
if the exact event is absent: validate and append it
sync the file and its directory, including on an exact retry
release the lock, then acknowledge
```

Gap: durable, repeatable acknowledgements required a concurrency owner. Reach:
cooperating writers must preserve the file's identity and use this lock. Syncing
on a retry also covers a predecessor that wrote the event but died before making
it durable. Verdict: sound because serialization and crash release use the same
existing file-lock primitive without a second ownership mechanism.

### Refuse to repair a corrupt submission journal

Confidence: high.

The provider can write its output directory directly and leave a malformed line
after an acknowledged choice. A restarted submission server refuses to append;
it does not truncate the tail or guess the intended event. Host acceptance can
preserve the valid preceding choice as a partial audit. Repairing the journal
would hide the damaged output and could make an unfinished attempt appear clean.

Gap: hostile-output handling did not decide whether the tool should repair its
input. Reach: corruption reduces the attempt's authority rather than authorizing
rewrites; a new execution is a separate attempt, not an erased tail. Verdict:
sound because useful validated evidence survives without manufacturing completion.

### Keep choices readable when canonical scope is unknown

Confidence: high.

A cloned repository contains a verified receipt-retention choice, but its owner
has not configured the canonical branch—the branch used to decide which choices
describe the main line of work. Factory shows the explanation as unclassified
and read-only. It does not invent lifecycle or human-confirmation status, and it
does not issue the state fingerprint required to submit an action. Hiding the
whole history would remove useful evidence just because mutation authority is
unavailable.

Gap: readable choices were required, but missing canonical policy had no defined
presentation. Reach: future unavailable-authority states should disable actions
without silently discarding verified explanations. Verdict: sound because
reading evidence and authorizing a change are different capabilities.

### Use canonical scope only to break confidence ties

Confidence: high.

Two needs-user choices have low confidence: one describes the canonical branch,
the other a proposal branch. Factory shows the canonical choice first. A
medium-confidence canonical choice still follows both low-confidence choices;
scope does not override uncertainty. The domain projection, not each browser,
applies this ordering.

```text
group by verdict
within each group: confidence from low to high
then canonical scope before other scope
then existing priority and stable identifiers
```

Gap: canonical priority and least-confident-first ordering did not specify which
rule wins. Reach: all consumers get the same order without changing choice
presence or human status. Verdict: sound because scope resolves ties instead of
quietly hiding the choices most likely to need scrutiny.

### Preserve a scope summary without claiming the audit finished

Confidence: high.

A reviewer submits a cited account of the histories it read, then crashes before
submitting choices or finishing. Factory retains that account as a partial audit,
not a declaration that no choices exist. Conversely, a choice submitted before
the summary can survive on its own. A completed empty audit needs an explicit
finish and a cited explanation of why no undeclared choice was found.

Gap: partial output and completed empty audits had different meanings, but the
durable summary's optionality was unspecified. Reach: a partial ledger can have
useful entries without a summary, or a summary without entries. Requiring both
would discard valid work; accepting either as completion would invent assurance.
Verdict: sound because retention and completion remain separate judgments.

### Retain provider diagnostics separately from semantic submissions

Confidence: high.

A provider finishes with a prose explanation while the submission tool has
recorded typed choices. If publication is interrupted, the private review
attempt retains both bounded streams separately. Recovery can replay acceptance
of the submissions, while diagnostics still explain how the provider ended.
Discarding final text immediately would lose troubleshooting context; folding it
into submissions would create an ambiguous second source of review meaning.

Gap: the private attempt's storage shape had to retain both channels without
making diagnostics semantic authority. Reach: only validated, sanitized
submissions can become portable review records; final provider text remains
private and is never a fallback when submissions are absent. Successful
publication removes the transient attempt. Verdict: sound because diagnostics
survive an interrupted publication without becoming another public response copy.
