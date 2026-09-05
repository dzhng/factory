# Configuration completion verification

The configuration pass implements the remaining resource and update-check
preferences. Its product-policy choices are recorded in the
[choices ledger](../choices.md).

## Evidence boundaries

The installed-CLI Docker vertical verifies field-wise configuration precedence,
invalid-value refusal before mutation, public release discovery, private cached
warnings, repository opt-out, silent capture/background review, and bounded
response reads. Its external HTTP and Docker-process boundaries use controlled
fixtures; it does not claim authenticated-provider or published-release authority.

The live reviewer-isolation journey observes requested memory, CPU, process, and
swap constraints on real Docker containers. The live review-CLI journey carries
global, repository, and command-flag preferences into that boundary and verifies
a configured deadline through the immutable review manifest.

Red/green checks demonstrated missing resource settings, ignored Docker resource
preferences, ignored execution deadlines, oversized update metadata, and setup
timeouts incorrectly recorded as Docker unavailability. Restored implementations
passed their affected checks. The repository build, format, type, lint, and test
gates passed; affected CLI and reviewer checks were rerun after review corrections.

## Review resolution

Independent Codex review identified setup-time deadline misclassification. Docker
pull, inspection, and startup now propagate typed timeout/cancellation results;
expired deadlines do not begin another setup operation. Interrupted container
creation still preserves the existing cleanup-unproven refusal: a timeout alone
does not prove that the Docker daemon cannot finish creating a container later.

A second review identified a root-CI evidence-mount problem in a proposed
test-runner UID change. That runner change was removed. Only the new credential
fixture changes its disposable owner and child UID when needed, preserving both
real non-root credential checks and existing writable-evidence behavior.

The touched deterministic CLI journey explicitly excludes ambient Claude login
discovery and isolates Factory configuration/cache locations. It uses only fake
provider credentials; authenticated exact-artifact certification remains a
separate release gate.
