# 3 — Provider capture and durable replay

Depends on slice 2; this slice publishes the full sanitized Turn graph.

## Contract and seam

Provider adapters recognize native result payloads and transform all retained
hook/transcript messages through the shared policy. Preserve event membership,
native result identity, and readable unknown records without promising byte-for-
byte fidelity. Parsed copies receive the same treatment. Apply one tool-result
budget across text blocks, not one budget per leaf or user-role envelope.

Extend the existing private journal claim with a durable sanitized preparation:
safe object/record bytes and refs, transformation metadata, frozen completeness
findings, and binding to exact claimed membership. Complete this preparation
before any Turn graph writes, including CAS. Preparation is private, bounded,
create-once, and reclaimed using the existing verified-completion authority.
Do not persist the dictionary or create a parallel journal service.

Replace raw-hash equality in `planTurn`, lifecycle capture, interrupted-prefix
verification, and completion with the prepared-evidence binding. Provider originals
remain unchanged. Validate transcript lag on the original input before sanitizing,
then freeze the finding. Recovery reuses prepared bytes after env rotation; it
does not regenerate a competing immutable prefix.

## Red/green and inspectable result

Extend capture's materialization/evidence-graph tests and the journal crash lab in
Docker. Replay both provider fixtures with secrets in user, assistant, tool input,
result, unknown nested fields, and hook payloads. Keep long user/assistant/tool
argument text; reduce recognized results. Verify malformed-line omission preserves
readable siblings and cannot leak its original bytes.

Crash before preparation commits, after it commits, after each object/record
prefix, and before the trigger. Rotate/remove env files between crash and retry.
Assert byte-identical prepared replay, valid completion, no duplicate coverage,
and no seeded secrets in any physical `.factory` file. Before-preparation retries
use current discovery and must not claim to remember removed values.

The report shows retained reasoning and partial-evidence limitations for both
providers. Record its invocation/verdict here. Capture failure must remain
fail-open for the coding provider and recoverable privately.

## Handoff and freedoms

Update SECURITY and capture/journal documentation to distinguish raw private
observations from portable sanitized evidence. Remove stale lossless-public tests
and comments rather than adding compatibility branches. Delegate private storage
layout within the current journal owner and supported provider-shape factoring;
do not delegate replay identity, raw fallback, or message budgets. Commit/push green.
