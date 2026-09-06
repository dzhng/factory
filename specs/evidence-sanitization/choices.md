# Implementation choices

## Sound

### Bound the matcher's memory as well as filesystem input

- **When:** policy/discovery pass.
- **Choice:** If a repository supplies a huge env value or text containing too
  many separate secret matches, preparation reports a fixed resource-limit
  failure. A hook can still return normally, but cannot publish unprocessed
  evidence. Reading a bounded file alone does not bound the larger in-memory
  search structure built from it. Repeated adjacent matches collapse into one
  redaction instead of exhausting the allowance.
- **Gap:** The plan bounded discovery but did not specify the matcher's internal
  storage ceiling. The chosen ceilings are recorded in the contract, backed by
  an oversized-dictionary regression and a repetitive-input probe.
- **Reach:** Producers must handle this as unavailable preparation, not fall back
  to raw publication. This can reject unusual inputs rather than risk an out-of-
  memory hook process.
- **Verdict:** sound; a fixed explicit failure preserves the publication boundary.
- **Confidence:** medium.

### Treat invalid UTF-8 and NUL-bearing source as unsupported text

- **When:** source observation pass.
- **Choice:** A binary file can contain text-like fragments, but Factory does not
  try to redact those fragments and publish the surrounding opaque bytes. A file
  that cannot decode strictly as UTF-8, or contains a NUL character, is omitted
  with a fixed reason. Other UTF-8 source remains reviewable, without relying on
  filename extensions. Leading byte-order marks remain part of retained text.
- **Gap:** The plan required omission of unsupported binary source without naming
  a text-classification rule.
- **Reach:** Some unusual NUL-bearing text is omitted rather than transformed;
  binary formats are not promised redaction support. This is a bounded text
  policy, not a general file-type detector.
- **Verdict:** sound; it avoids copying opaque source payloads while retaining
  common source encodings.
- **Confidence:** medium.

### Supplement Docker with isolated native platform probes

- **When:** policy/discovery pass.
- **Choice:** A filesystem flag that behaves differently on macOS must be tested
  on macOS as well as in the Linux Docker suite. The native probe uses a disposable
  temporary directory and a bounded child process; it never touches provider
  homes, hooks, or `.factory`. Docker remains the normal filesystem test gate.
- **Gap:** The plan's pure-tests-only host wording could not prove the required
  Darwin behavior. AGENTS permits isolated tests that do not touch the named live
  boundaries; the handoff now describes this supplemental platform check.
- **Reach:** Platform-specific filesystem changes inherit real platform evidence,
  without granting tests access to the developer's provider configuration.
- **Verdict:** sound; it strengthens rather than substitutes verification.
- **Confidence:** high.

### Verify selected bytes again without treating excluded content as input

- **When:** policy/discovery pass.
- **Choice:** If one env file changes while a later directory is scanned, compare
  its final bytes with the already-read value before returning the secret context.
  File timestamps alone can miss a same-size overwrite. The second read uses
  bounded chunks, not another complete copy. A build directory excluded by policy
  may change its contents without failing discovery; its identity still must not
  be replaced while inspected.
- **Gap:** The plan required race detection but did not define whether unchanged
  metadata proves unchanged content, or whether excluded content churn matters.
- **Reach:** Discovery does one extra bounded read of included env files. It does
  not expand its secret dictionary into excluded trees or make their routine
  writes block capture.
- **Verdict:** sound; check the bytes that determine protection, not unrelated
  content that the policy intentionally excludes.
- **Confidence:** high.

### Redact overlapping values together and retain both env spellings

- **When:** policy/discovery pass.
- **Choice:** If one secret covers `abc` and another covers `bcde`, text `abcde`
  becomes one redaction marker. Replacing only the longer value would leave the
  first secret's `a` visible. Likewise an env value written using an escaped
  newline is matched both when copied verbatim and when decoded into a message.
- **Gap:** The plan required deterministic overlapping matching and decoded env
  values but did not specify these two representation details.
- **Reach:** The same secret is protected in copied file output and decoded JSON;
  overlapping matches cannot leak each other's edge fragments.
- **Verdict:** sound; it protects the union of known sensitive content without
  adding a general-purpose recursive decoding system.
- **Confidence:** high.

### Opaque JSON scalars do not inherit structural-ID exemptions

- **When:** policy/discovery pass.
- **Choice:** If a provider payload contains a numeric password, it can become
  a redaction marker just like a string password. Validated Factory record IDs
  and counters have separate schema authority; an arbitrary number in opaque
  provider data does not acquire that authority merely by being numeric.
- **Gap:** The plan described decoded JSON strings explicitly, but all-message
  protection also has to cover numeric credentials.
- **Reach:** Opaque provider JSON may change scalar types where a secret is
  removed. Provider metadata is classified before transformation; portable
  structural fields must use their validated producer contract.
- **Verdict:** sound; no free bypass for numeric secrets.
- **Confidence:** high.
