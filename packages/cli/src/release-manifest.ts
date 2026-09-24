import { createHash } from 'node:crypto'

export const RELEASE_ARCHIVE_MAXIMUM_BYTES = 96 * 1024 * 1024
export const RELEASE_METADATA_MAXIMUM_BYTES = 1024 * 1024
const allowedEntries = new Set([
  'factory',
  'manifest.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'BUN-1.3.14-LICENSE.md',
  'sbom.spdx.json',
])

export type ReleaseTarget = 'bun-darwin-arm64' | 'bun-linux-x64-baseline'

const verifiedReleaseAuthority = new WeakSet<VerifiedRelease>()

export class VerifiedRelease {
  readonly version: string
  readonly revision: string
  readonly target: ReleaseTarget
  readonly manifestSha256: string
  readonly archiveSha256: string
  readonly executableSha256: string
  readonly #executable: Uint8Array

  get executable(): Uint8Array {
    return this.#executable.slice()
  }

  constructor(
    value: Omit<VerifiedRelease, 'executable'> & { executable: Uint8Array },
    authority: symbol,
  ) {
    if (authority !== verifiedReleaseConstructorAuthority)
      throw new TypeError('VerifiedRelease can only be minted by artifact verification')
    this.version = value.version
    this.revision = value.revision
    this.target = value.target
    this.manifestSha256 = value.manifestSha256
    this.archiveSha256 = value.archiveSha256
    this.executableSha256 = value.executableSha256
    this.#executable = value.executable.slice()
    verifiedReleaseAuthority.add(this)
    Object.freeze(this)
  }
}

const verifiedReleaseConstructorAuthority = Symbol('verified release constructor')

export function assertVerifiedRelease(value: unknown): asserts value is VerifiedRelease {
  if (!(value instanceof VerifiedRelease) || !verifiedReleaseAuthority.has(value))
    throw new TypeError('upgrade requires a verified release capability')
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
  if (bytes.byteLength > RELEASE_METADATA_MAXIMUM_BYTES)
    throw new TypeError(`${name} exceeds its size bound`)
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
  if (file.size > RELEASE_ARCHIVE_MAXIMUM_BYTES)
    throw new TypeError(`${name} exceeds its size bound`)
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
  if (input.archive.byteLength === 0 || input.archive.byteLength > RELEASE_ARCHIVE_MAXIMUM_BYTES) {
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
  const artifact = object(content.artifact, 'executable artifact')
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
  return new VerifiedRelease(
    {
      ...contentIdentity,
      manifestSha256,
      archiveSha256: archiveDigest,
      executableSha256,
      executable,
    },
    verifiedReleaseConstructorAuthority,
  )
}
