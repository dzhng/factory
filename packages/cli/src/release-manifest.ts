import { createHash } from 'node:crypto'

const maximumArchiveBytes = 96 * 1024 * 1024
const maximumMetadataBytes = 1024 * 1024
const allowedEntries = new Set([
  'factory',
  'manifest.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'BUN-1.3.14-LICENSE.md',
  'sbom.spdx.json',
])

export type ReleaseTarget = 'bun-darwin-arm64' | 'bun-linux-x64-baseline'

export type VerifiedRelease = {
  version: string
  revision: string
  target: ReleaseTarget
  manifestSha256: string
  archiveSha256: string
  executableSha256: string
  executable: Uint8Array
}

type JsonObject = Record<string, unknown>

function object(value: unknown, name: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`)
  }
  return value as JsonObject
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  return value
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative integer`)
  }
  return value as number
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseJson(bytes: Uint8Array, name: string): JsonObject {
  if (bytes.byteLength > maximumMetadataBytes) throw new TypeError(`${name} exceeds its size bound`)
  try {
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), name)
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError(`${name} is not valid JSON`)
  }
}

function target(value: unknown): ReleaseTarget {
  if (value !== 'bun-darwin-arm64' && value !== 'bun-linux-x64-baseline') {
    throw new TypeError('release target is unsupported')
  }
  return value
}

function releaseIdentity(value: unknown): {
  version: string
  revision: string
  target: ReleaseTarget
} {
  const release = object(value, 'release identity')
  const version = string(release.version, 'release version')
  const revision = string(release.revision, 'release revision')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new TypeError('release version must be semantic')
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new TypeError('release revision must be a Git SHA')
  return { version, revision, target: target(release.target) }
}

async function bytes(file: File, name: string): Promise<Uint8Array> {
  if (file.size > maximumArchiveBytes) throw new TypeError(`${name} exceeds its size bound`)
  return new Uint8Array(await file.arrayBuffer())
}

/**
 * Turns an untrusted release archive into the only capability accepted by the
 * upgrade planner. The adjacent digest covers transport; the inner manifest
 * independently pins the executable and all release identity.
 */
export async function verifyReleaseArtifact(input: {
  archive: Uint8Array
  adjacentManifest: Uint8Array
  expectedManifestSha256: string
  expectedTarget: ReleaseTarget
}): Promise<VerifiedRelease> {
  if (input.archive.byteLength === 0 || input.archive.byteLength > maximumArchiveBytes) {
    throw new TypeError('release archive exceeds its size bound')
  }
  const manifestSha256 = sha256(input.adjacentManifest)
  if (!/^[0-9a-f]{64}$/.test(input.expectedManifestSha256)) {
    throw new TypeError('trusted release manifest digest is invalid')
  }
  if (manifestSha256 !== input.expectedManifestSha256) {
    throw new TypeError('trusted release manifest digest mismatch')
  }
  const adjacent = parseJson(input.adjacentManifest, 'adjacent release manifest')
  if (adjacent.schemaVersion !== 1) throw new TypeError('unsupported release manifest version')
  const adjacentIdentity = releaseIdentity(adjacent.release)
  if (adjacentIdentity.target !== input.expectedTarget)
    throw new TypeError('release target mismatch')
  const adjacentArtifact = object(adjacent.artifact, 'release artifact')
  const expectedStem = `factory-v${adjacentIdentity.version}-${adjacentIdentity.target.replace(/^bun-/, '')}`
  if (string(adjacentArtifact.file, 'archive file') !== `${expectedStem}.tar.gz`) {
    throw new TypeError('release archive name does not match its identity')
  }
  if (integer(adjacentArtifact.bytes, 'archive bytes') !== input.archive.byteLength) {
    throw new TypeError('release archive length mismatch')
  }
  const archiveDigest = sha256(input.archive)
  if (string(adjacentArtifact.sha256, 'archive digest') !== archiveDigest) {
    throw new TypeError('release archive digest mismatch')
  }

  const files = await new Bun.Archive(input.archive).files()
  if (
    files.size !== allowedEntries.size ||
    [...files.keys()].some(name => !allowedEntries.has(name))
  ) {
    throw new TypeError('release archive content is not allowlisted')
  }
  const contentManifest = await bytes(files.get('manifest.json')!, 'content manifest')
  if (
    string(adjacentArtifact.contentManifestSha256, 'content manifest digest') !==
    sha256(contentManifest)
  ) {
    throw new TypeError('release content manifest digest mismatch')
  }
  const content = parseJson(contentManifest, 'release content manifest')
  if (content.schemaVersion !== 1) throw new TypeError('unsupported content manifest version')
  const contentIdentity = releaseIdentity(content.release)
  if (JSON.stringify(contentIdentity) !== JSON.stringify(adjacentIdentity)) {
    throw new TypeError('release identity manifests disagree')
  }
  const build = object(content.build, 'release build')
  const bunVersion = string(build.bunVersion, 'release Bun version')
  if (bunVersion !== '1.3.14' || !files.has(`BUN-${bunVersion}-LICENSE.md`)) {
    throw new TypeError('release Bun license inventory does not match its runtime')
  }
  const artifact = object(content.artifact, 'executable artifact')
  const license = object(content.license, 'release license')
  if (
    license.concluded !== 'MIT' ||
    license.file !== 'LICENSE' ||
    license.thirdPartyNotices !== 'THIRD_PARTY_NOTICES.md'
  ) {
    throw new TypeError('release license inventory is invalid')
  }
  const sbomReference = object(content.sbom, 'release SBOM reference')
  if (sbomReference.format !== 'SPDX-2.3' || sbomReference.file !== 'sbom.spdx.json') {
    throw new TypeError('release SBOM reference is invalid')
  }
  if (string(artifact.file, 'executable file') !== 'factory') {
    throw new TypeError('release executable has an unexpected name')
  }
  const executable = await bytes(files.get('factory')!, 'release executable')
  if (integer(artifact.bytes, 'executable bytes') !== executable.byteLength) {
    throw new TypeError('release executable length mismatch')
  }
  const executableSha256 = sha256(executable)
  if (string(artifact.sha256, 'executable digest') !== executableSha256) {
    throw new TypeError('release executable digest mismatch')
  }
  const metadata = object(content.metadata, 'release metadata inventory')
  if (
    Object.keys(metadata).length !== 4 ||
    Object.keys(metadata).some(name => !allowedEntries.has(name) || name === 'factory')
  ) {
    throw new TypeError('release metadata inventory is not allowlisted')
  }
  for (const name of [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'BUN-1.3.14-LICENSE.md',
    'sbom.spdx.json',
  ] as const) {
    const file = files.get(name)!
    if (file.size === 0 || file.size > maximumMetadataBytes) {
      throw new TypeError(`${name} is empty or exceeds its size bound`)
    }
    const expected = object(metadata[name], `release metadata ${name}`)
    const value = await bytes(file, name)
    if (
      integer(expected.bytes, `${name} bytes`) !== value.byteLength ||
      string(expected.sha256, `${name} digest`) !== sha256(value)
    ) {
      throw new TypeError(`${name} does not match its manifest`)
    }
  }
  const sbom = parseJson(await bytes(files.get('sbom.spdx.json')!, 'release SBOM'), 'release SBOM')
  const creationInfo = object(sbom.creationInfo, 'release SBOM creation info')
  const creators = creationInfo.creators
  if (
    sbom.spdxVersion !== 'SPDX-2.3' ||
    sbom.dataLicense !== 'CC0-1.0' ||
    sbom.SPDXID !== 'SPDXRef-DOCUMENT' ||
    sbom.name !== expectedStem ||
    sbom.documentNamespace !==
      `https://github.com/dzhng/factory/releases/download/v${contentIdentity.version}/${expectedStem}.spdx` ||
    typeof creationInfo.created !== 'string' ||
    !Number.isFinite(Date.parse(creationInfo.created)) ||
    !Array.isArray(creators) ||
    !creators.includes('Tool: factory-release-builder')
  ) {
    throw new TypeError('release SBOM document identity is invalid')
  }
  const packages = sbom.packages
  if (!Array.isArray(packages)) throw new TypeError('release SBOM packages are invalid')
  const components = new Map(
    packages.map(value => {
      const component = object(value, 'release SBOM package')
      return [string(component.name, 'release SBOM package name'), component]
    }),
  )
  if (
    components.size !== 2 ||
    components.get('factory')?.SPDXID !== 'SPDXRef-Factory' ||
    components.get('factory')?.versionInfo !== contentIdentity.version ||
    components.get('factory')?.licenseDeclared !== 'MIT' ||
    components.get('bun-runtime')?.SPDXID !== 'SPDXRef-Bun-Runtime' ||
    components.get('bun-runtime')?.versionInfo !== bunVersion
  ) {
    throw new TypeError('release SBOM inventory does not match its artifact')
  }
  const relationships = sbom.relationships
  if (
    !Array.isArray(relationships) ||
    relationships.length !== 2 ||
    !relationships.some(value => {
      const relation = object(value, 'release SBOM relationship')
      return (
        relation.spdxElementId === 'SPDXRef-DOCUMENT' &&
        relation.relationshipType === 'DESCRIBES' &&
        relation.relatedSpdxElement === 'SPDXRef-Factory'
      )
    }) ||
    !relationships.some(value => {
      const relation = object(value, 'release SBOM relationship')
      return (
        relation.spdxElementId === 'SPDXRef-Factory' &&
        relation.relationshipType === 'DEPENDS_ON' &&
        relation.relatedSpdxElement === 'SPDXRef-Bun-Runtime'
      )
    })
  ) {
    throw new TypeError('release SBOM relationships are invalid')
  }
  const executableBytes = Buffer.from(
    executable.buffer,
    executable.byteOffset,
    executable.byteLength,
  )
  for (const prohibited of [
    'coding-agent-plugin',
    '/Users/david/dev/',
    'SUPABASE_SERVICE_ROLE_KEY',
    'packages/control-plane/',
  ]) {
    if (executableBytes.includes(prohibited)) {
      throw new TypeError(`release executable contains prohibited content: ${prohibited}`)
    }
  }
  return {
    ...contentIdentity,
    manifestSha256,
    archiveSha256: archiveDigest,
    executableSha256,
    executable,
  }
}
