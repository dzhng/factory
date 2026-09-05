import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { verifyReleaseArtifact } from '../packages/cli/src/release-manifest'
import { createReleaseArchive } from './release-archive'
import { verifiedSourceRevision } from './release-source'

type ReleaseTarget = 'bun-darwin-arm64' | 'bun-linux-x64-baseline'

const targets: ReadonlySet<string> = new Set<ReleaseTarget>([
  'bun-darwin-arm64',
  'bun-linux-x64-baseline',
])

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function requiredOption(name: string): string {
  const value = option(name)
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`)
  return value
}

const version = requiredOption('--version')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new TypeError('release version must be semantic')
}
const target = requiredOption('--target')
if (!targets.has(target)) throw new TypeError(`unsupported release target: ${target}`)
const releaseTarget = target as ReleaseTarget
const repositoryRoot = resolve(import.meta.dir, '..')
const revision = verifiedSourceRevision(repositoryRoot, option('--revision'))
const outputRoot = resolve(option('--output') ?? join(repositoryRoot, 'artifacts', 'release'))
const stem = `factory-v${version}-${releaseTarget.replace(/^bun-/, '')}`
const targetRoot = join(outputRoot, stem)
const executablePath = join(targetRoot, 'factory')
await mkdir(outputRoot, { recursive: true, mode: 0o755 })
await mkdir(targetRoot, { mode: 0o755 })

const result = await Bun.build({
  entrypoints: [join(repositoryRoot, 'packages', 'cli', 'src', 'main.ts')],
  compile: {
    target: releaseTarget,
    outfile: executablePath,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  define: {
    __FACTORY_VERSION__: JSON.stringify(version),
    __FACTORY_REVISION__: JSON.stringify(revision),
    __FACTORY_TARGET__: JSON.stringify(releaseTarget),
  },
  minify: true,
})
if (!result.success) throw new AggregateError(result.logs, 'release compilation failed')

const executable = Bun.file(executablePath)
const executableBytes = await executable.bytes()
const digest = createHash('sha256').update(executableBytes).digest('hex')
const executableStat = await stat(executablePath)
const created = new Date().toISOString()
const sbomFile = 'sbom.spdx.json'
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: stem,
  documentNamespace: `https://github.com/dzhng/factory/releases/download/v${version}/${stem}.spdx`,
  creationInfo: { created, creators: ['Tool: factory-release-builder'] },
  packages: [
    {
      SPDXID: 'SPDXRef-Factory',
      name: 'factory',
      versionInfo: version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'MIT',
      licenseDeclared: 'MIT',
    },
    {
      SPDXID: 'SPDXRef-Bun-Runtime',
      name: 'bun-runtime',
      versionInfo: Bun.version,
      downloadLocation: `https://github.com/oven-sh/bun/releases/tag/bun-v${Bun.version}`,
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      externalRefs: [
        {
          referenceCategory: 'OTHER',
          referenceType: 'license-notice',
          referenceLocator: `https://github.com/oven-sh/bun/blob/bun-v${Bun.version}/LICENSE.md`,
        },
      ],
    },
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
const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
const licenseBytes = await Bun.file(join(repositoryRoot, 'LICENSE')).bytes()
const noticesBytes = await Bun.file(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md')).bytes()
const bunLicenseName = `BUN-${Bun.version}-LICENSE.md`
const bunLicenseBytes = await Bun.file(join(repositoryRoot, 'licenses', bunLicenseName)).bytes()
const sbomBytes = encode(`${JSON.stringify(sbom, null, 2)}\n`)
const metadataEntries = [
  ['LICENSE', licenseBytes],
  ['THIRD_PARTY_NOTICES.md', noticesBytes],
  [bunLicenseName, bunLicenseBytes],
  [sbomFile, sbomBytes],
] as const
const metadata = Object.fromEntries(
  metadataEntries.map(([name, value]) => [
    name,
    {
      bytes: value.byteLength,
      sha256: createHash('sha256').update(value).digest('hex'),
    },
  ]),
)
const manifest = {
  schemaVersion: 1,
  release: { version, revision, target: releaseTarget },
  artifact: {
    file: 'factory',
    bytes: executableStat.size,
    sha256: digest,
  },
  build: { bunVersion: Bun.version, createdAt: created },
  license: { concluded: 'MIT', file: 'LICENSE', thirdPartyNotices: 'THIRD_PARTY_NOTICES.md' },
  sbom: { format: 'SPDX-2.3', file: sbomFile },
  metadata,
}
for (const [name, value] of metadataEntries) {
  await writeFile(join(targetRoot, name), value, { flag: 'wx', mode: 0o644 })
}
const manifestBytes = encode(`${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(join(targetRoot, 'manifest.json'), manifestBytes, {
  flag: 'wx',
  mode: 0o644,
})
const archivePath = join(outputRoot, `${stem}.tar.gz`)
const adjacentManifestPath = join(outputRoot, `${stem}.json`)
if ((await Bun.file(archivePath).exists()) || (await Bun.file(adjacentManifestPath).exists())) {
  throw new Error('release artifact already exists')
}
await writeFile(
  archivePath,
  createReleaseArchive([
    { name: 'factory', bytes: executableBytes, mode: 0o755 },
    { name: 'manifest.json', bytes: manifestBytes, mode: 0o644 },
    { name: 'LICENSE', bytes: licenseBytes, mode: 0o644 },
    { name: 'THIRD_PARTY_NOTICES.md', bytes: noticesBytes, mode: 0o644 },
    { name: bunLicenseName, bytes: bunLicenseBytes, mode: 0o644 },
    { name: sbomFile, bytes: sbomBytes, mode: 0o644 },
  ]),
  { flag: 'wx', mode: 0o644 },
)
const archiveBytes = await Bun.file(archivePath).bytes()
const adjacentManifest = {
  schemaVersion: 1,
  release: manifest.release,
  artifact: {
    file: `${stem}.tar.gz`,
    bytes: archiveBytes.byteLength,
    sha256: createHash('sha256').update(archiveBytes).digest('hex'),
    contentManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  },
}
await writeFile(adjacentManifestPath, `${JSON.stringify(adjacentManifest, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o644,
})
await verifyReleaseArtifact({
  archive: archiveBytes,
  adjacentManifest: await Bun.file(adjacentManifestPath).bytes(),
  expectedManifestSha256: createHash('sha256')
    .update(await Bun.file(adjacentManifestPath).bytes())
    .digest('hex'),
  expectedTarget: releaseTarget,
})
process.stdout.write(`${archivePath}\n${adjacentManifest.artifact.sha256}\n`)
