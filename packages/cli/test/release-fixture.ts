import { createHash } from 'node:crypto'

import type { ReleaseTarget } from '../src/release-manifest'

const encoder = new TextEncoder()

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function releaseFixture(
  options: {
    target?: ReleaseTarget
    version?: string
    executable?: Uint8Array
    extra?: Record<string, string>
    validSbom?: boolean
  } = {},
) {
  const identity = {
    version: options.version ?? '0.1.0-test.1',
    revision: 'a'.repeat(40),
    target: options.target ?? ('bun-darwin-arm64' as ReleaseTarget),
  }
  const executable = options.executable ?? encoder.encode('test executable')
  const stem = `factory-v${identity.version}-${identity.target.replace(/^bun-/, '')}`
  const sbom = {
    ...(options.validSbom === false
      ? {}
      : {
          spdxVersion: 'SPDX-2.3',
          dataLicense: 'CC0-1.0',
          SPDXID: 'SPDXRef-DOCUMENT',
          name: stem,
          documentNamespace: `https://github.com/dzhng/factory/releases/download/v${identity.version}/${stem}.spdx`,
          creationInfo: {
            created: '2026-09-05T00:00:00.000Z',
            creators: ['Tool: factory-release-builder'],
          },
        }),
    packages: [
      {
        SPDXID: 'SPDXRef-Factory',
        name: 'factory',
        versionInfo: identity.version,
        licenseDeclared: 'MIT',
      },
      { SPDXID: 'SPDXRef-Bun-Runtime', name: 'bun-runtime', versionInfo: '1.3.14' },
    ],
    relationships: [
      {
        spdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DESCRIBES',
        relatedSpdxElement: 'SPDXRef-Factory',
      },
      {
        spdxElementId: 'SPDXRef-Factory',
        relationshipType: 'DEPENDS_ON',
        relatedSpdxElement: 'SPDXRef-Bun-Runtime',
      },
    ],
  }
  const metadataFiles = {
    LICENSE: encoder.encode('MIT'),
    'THIRD_PARTY_NOTICES.md': encoder.encode('Bun'),
    'BUN-1.3.14-LICENSE.md': encoder.encode('Bun license inventory'),
    'sbom.spdx.json': encoder.encode(JSON.stringify(sbom)),
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
      ...options.extra,
    },
    { compress: 'gzip' },
  ).bytes()
  const adjacentManifest = encoder.encode(
    `${JSON.stringify({
      schemaVersion: 1,
      release: identity,
      artifact: {
        file: `${stem}.tar.gz`,
        bytes: archive.byteLength,
        sha256: digest(archive),
        contentManifestSha256: digest(contentManifest),
      },
    })}\n`,
  )
  return {
    identity,
    executable,
    archive,
    adjacentManifest,
    expectedManifestSha256: digest(adjacentManifest),
  }
}
