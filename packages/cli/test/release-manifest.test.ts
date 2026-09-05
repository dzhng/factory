import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { verifyReleaseArtifact, type ReleaseTarget } from '../src/release-manifest'

const encoder = new TextEncoder()
const identity = {
  version: '0.1.0-test.1',
  revision: 'a'.repeat(40),
  target: 'bun-darwin-arm64' as ReleaseTarget,
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fixture(extra: Record<string, string> = {}) {
  const executable = encoder.encode('test executable')
  const metadataFiles = {
    LICENSE: encoder.encode('MIT'),
    'THIRD_PARTY_NOTICES.md': encoder.encode('Bun'),
    'BUN-1.3.14-LICENSE.md': encoder.encode('Bun license inventory'),
    'sbom.spdx.json': encoder.encode(
      JSON.stringify({
        packages: [
          { name: 'factory', versionInfo: identity.version, licenseDeclared: 'MIT' },
          { name: 'bun-runtime', versionInfo: '1.3.14' },
        ],
      }),
    ),
  }
  const metadata = Object.fromEntries(
    Object.entries(metadataFiles).map(([name, bytes]) => [
      name,
      { bytes: bytes.byteLength, sha256: digest(bytes) },
    ]),
  )
  const contentManifest = encoder.encode(
    `${JSON.stringify({
      schemaVersion: 1,
      release: identity,
      artifact: { file: 'factory', bytes: executable.byteLength, sha256: digest(executable) },
      build: { bunVersion: '1.3.14' },
      license: {
        concluded: 'MIT',
        file: 'LICENSE',
        thirdPartyNotices: 'THIRD_PARTY_NOTICES.md',
      },
      sbom: { format: 'SPDX-2.3', file: 'sbom.spdx.json' },
      metadata,
    })}\n`,
  )
  const archive = await new Bun.Archive(
    {
      factory: executable,
      'manifest.json': contentManifest,
      ...metadataFiles,
      ...extra,
    },
    { compress: 'gzip' },
  ).bytes()
  const adjacentManifest = encoder.encode(
    `${JSON.stringify({
      schemaVersion: 1,
      release: identity,
      artifact: {
        file: `factory-v${identity.version}-darwin-arm64.tar.gz`,
        bytes: archive.byteLength,
        sha256: digest(archive),
        contentManifestSha256: digest(contentManifest),
      },
    })}\n`,
  )
  return {
    archive,
    adjacentManifest,
    expectedManifestSha256: digest(adjacentManifest),
  }
}

describe('release artifact verification', () => {
  test('mints a verified release only from the exact allowlisted archive', async () => {
    const value = await fixture()
    const verified = await verifyReleaseArtifact({ ...value, expectedTarget: identity.target })
    expect(verified.version).toBe(identity.version)
    expect(verified.executableSha256).toBe(digest(verified.executable))
  })

  test('rejects extra content even when the transport digest covers it', async () => {
    const value = await fixture({ 'credentials.json': 'secret' })
    expect(verifyReleaseArtifact({ ...value, expectedTarget: identity.target })).rejects.toThrow(
      'content is not allowlisted',
    )
  })

  test('rejects the right bytes for the wrong platform', async () => {
    const value = await fixture()
    expect(
      verifyReleaseArtifact({ ...value, expectedTarget: 'bun-linux-x64-baseline' }),
    ).rejects.toThrow('target mismatch')
  })

  test('rejects a manifest that lacks the caller trusted digest', async () => {
    const value = await fixture()
    expect(
      verifyReleaseArtifact({
        ...value,
        expectedManifestSha256: '0'.repeat(64),
        expectedTarget: identity.target,
      }),
    ).rejects.toThrow('trusted release manifest digest mismatch')
  })
})
