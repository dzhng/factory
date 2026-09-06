# Release tooling

Native executables are the distribution authority. The release builder embeds
the exact clean checkout identity; the artifact verifier checks the archive,
inventory, executable, and license metadata before those bytes can be packaged.

The [release workflow](../.github/workflows/publish.yml) runs on stable `v*`
tags. It reuses CI's quality and native build jobs, then packages those exact
artifacts into public `@dzhng/factory` and publishes the native GitHub assets.
The npm package contains both supported binaries and a platform-selecting Node
launcher, with no install scripts or launcher downloads. This trades download
size for one package and one publication boundary.

Publishing requires npm authority for `@dzhng`: configure `NPM_TOKEN` in the
repository's Actions secrets, or authorize `publish.yml` as an npm trusted
publisher. The workflow requests provenance. Tokens never belong in source,
package contents, or test fixtures.

Tags and published versions are immutable release identities. Use a new patch
tag for a new source revision. If only publication fails, rerun the failed job
so it reuses the original native artifacts; rebuilding a version with different
bytes is not recovery. Existing GitHub assets must match before npm publication
can resume.

The [npm install journey](../packages/test-harness/src/run-npm-install.ts)
installs the actual packed tarball offline in Docker, launches it without Bun,
and checks successful version output, nonzero failure propagation, and explicit
hook installation/removal using the bundled executable's real path.
