# Candidate verification

Candidate `0.1.0` was built from `51ea46c3698c63e358c0c23f27c15b1fa025aa42`.
[CI run 33982393904](https://github.com/dzhng/factory/actions/runs/33982393904)
passed quality, native packaging, the Linux deterministic journey, and candidate
attestations. The downloaded macOS archive completed the same deterministic
journey locally without rebuilding. Exact identities and journey results are
retained in the [macOS report](macos-report.json) and [Linux report](linux-report.json).

Both downloaded archives and adjacent manifests passed `gh attestation verify`
with repository `dzhng/factory`, signer workflow
`dzhng/factory/.github/workflows/ci.yml`, and the exact source digest above.
Candidate provenance alone is not GitHub Release publication. At that checkpoint
the release had not been published.

The macOS check deliberately supplied missing test credential paths, preventing
real-provider execution after the earlier live Claude attempt reported revoked
OAuth authentication. Its `missing` status describes this controlled fixture
environment, not a new diagnosis of the user's provider installation. No host
provider configuration was modified and the unchanged revoked credential was
not retried during that fixture run. Both-provider authenticated certification
was still required at that checkpoint.

The subsequent user-requested retry completed both authenticated reviews using
the existing local logins and the production image. The
[authenticated macOS report](macos-authenticated-report.json) pins the same
archive, executable, and source identities as the fixture run. No credential
override or host login change was needed for that retry. Its provider inventory
describes CLI availability in the disposable host environment; the explicit
authenticated authorities and `review-codex` / `review-claude` journeys describe
the clients executed inside Docker.

## Publication

[GitHub Release v0.1.0](https://github.com/dzhng/factory/releases/tag/v0.1.0)
was published at `2026-09-05T21:01:22Z` as release `383372101`. Its tag resolves
to `51ea46c3698c63e358c0c23f27c15b1fa025aa42`. Both native archives and their
adjacent manifests were downloaded from the draft release, matched byte-for-byte
to the certified candidates, and passed source-pinned `gh attestation verify`
against the CI workflow. Published metadata retained those same four asset IDs
and digests. Publication promoted the certified bytes without rebuilding them.

The original report JSON retains its pre-publication unavailable authority.
This publication evidence supplements it rather than rewriting its verdict.
