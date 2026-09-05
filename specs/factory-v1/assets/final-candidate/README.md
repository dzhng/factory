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
Candidate provenance is not GitHub Release publication; no release was published.

The macOS check deliberately supplied missing test credential paths, preventing
real-provider execution after the earlier live Claude attempt reported revoked
OAuth authentication. Its `missing` status describes this controlled fixture
environment, not a new diagnosis of the user's provider installation. No host
provider configuration was modified and the unchanged revoked credential was
not retried. Both-provider authenticated certification is still required.

The subsequent user-requested retry completed both authenticated reviews using
the existing local logins and the production image. The
[authenticated macOS report](macos-authenticated-report.json) pins the same
archive, executable, and source identities as the fixture run. No credential
override or host login change was needed for that retry. Its provider inventory
describes CLI availability in the disposable host environment; the explicit
authenticated authorities and `review-codex` / `review-claude` journeys describe
the clients executed inside Docker.

The native candidate artifacts remain downloadable from the CI run. Release
publication must promote those exact bytes, not rebuild a lookalike. Candidate
verification does not itself prove subsequent GitHub Release publication.
