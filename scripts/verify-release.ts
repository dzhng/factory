import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { RELEASE_METADATA_MAXIMUM_BYTES } from '../packages/cli/src/release-manifest'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function hostTarget(): 'bun-darwin-arm64' | 'bun-linux-x64-baseline' | undefined {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'bun-darwin-arm64'
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: unknown } }
    | undefined
  if (
    process.platform === 'linux' &&
    process.arch === 'x64' &&
    typeof report?.header?.glibcVersionRuntime === 'string'
  )
    return 'bun-linux-x64-baseline'
  return undefined
}

async function run(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(args, { cwd: repositoryRoot, stdout: 'inherit', stderr: 'inherit' })
  if ((await child.exited) !== 0) throw new Error(`${args.join(' ')} failed`)
}

async function boundedManifestDigest(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size === 0 || info.size > RELEASE_METADATA_MAXIMUM_BYTES)
      throw new Error('release manifest is not a bounded ordinary file')
    const bytes = new Uint8Array(info.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) throw new Error('release manifest changed while reading')
      offset += bytesRead
    }
    if ((await handle.read(new Uint8Array(1), 0, 1, offset)).bytesRead !== 0)
      throw new Error('release manifest changed while reading')
    return createHash('sha256').update(bytes).digest('hex')
  } finally {
    await handle.close()
  }
}

const repositoryRoot = resolve(import.meta.dir, '..')
const target = hostTarget()
if (target === undefined) throw new Error('release certification requires a supported native host')
const version = option('--version')
if (version === undefined) throw new Error('--version is required')
const artifactRoot = option('--artifact-root')
const buildRoot =
  artifactRoot === undefined
    ? await mkdtemp(join(tmpdir(), 'factory-release-build-'))
    : resolve(artifactRoot)
if (artifactRoot === undefined)
  await run([
    process.execPath,
    join(repositoryRoot, 'scripts', 'build-release.ts'),
    '--version',
    version,
    '--target',
    target,
    '--output',
    buildRoot,
  ])
const stem = `factory-v${version}-${target.replace(/^bun-/, '')}`
const archive = join(buildRoot, `${stem}.tar.gz`)
const manifest = join(buildRoot, `${stem}.json`)
const manifestSha256 = await boundedManifestDigest(manifest)
const output = resolve(option('--output') ?? join(buildRoot, 'certification'))
const authenticatedReviewArguments = [['--reviewer-image', option('--reviewer-image')]].flatMap(
  ([name, value]) => (value === undefined ? [] : [name!, value]),
)
await run([
  process.execPath,
  join(repositoryRoot, 'packages', 'test-harness', 'src', 'run-release-certification.ts'),
  '--archive',
  archive,
  '--manifest',
  manifest,
  '--manifest-sha256',
  manifestSha256,
  '--expected-version',
  version,
  '--output',
  output,
  ...authenticatedReviewArguments,
])
