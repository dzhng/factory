# Evidence sanitization

This package owns the policy for turning sensitive text into portable review
evidence. Its secret context is ephemeral: callers can transform data, but
cannot obtain a credential dictionary or persist one for later reuse.

Discovery consumes a confined file reader supplied by the repository owner.
Keeping filesystem mechanics outside this package avoids a dependency cycle
and lets the same policy serve capture, Git observations, and review output.
The parser treats env files as data, including duplicate assignments; it never
executes them or changes process configuration.

Transformation precedes hashing. Known values and recognizable credentials are
redacted across decoded text; only explicitly identified tool results are
shortened. The policy does not identify provider payload shapes or grant
structural exemptions to arbitrary strings that resemble hashes. Those choices
belong to the producer's validated schema, not a global regex bypass.

Resource or parse failures carry fixed reasons rather than secret-bearing
input. The matcher has explicit memory/work ceilings and coalesces overlapping
matches so repeated values cannot multiply retained match records. This is
best-effort detection, not proof that arbitrary content contains no secrets.

The [policy probe](../test-harness/src/run-sanitization-policy.ts) uses synthetic
inputs only. Production publication boundaries are integrated by the active
[feature plan](../../specs/evidence-sanitization/README.md).
