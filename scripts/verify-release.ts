import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

const repositoryRoot = resolve(import.meta.dir, '..')
const target = hostTarget()
if (target === undefined) throw new Error('release certification requires a supported native host')
const version = option('--version')
if (version === undefined) throw new Error('--version is required')
const buildRoot = await mkdtemp(join(tmpdir(), 'factory-release-build-'))
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
const manifestSha256 = createHash('sha256')
  .update(await Bun.file(manifest).bytes())
  .digest('hex')
const output = resolve(option('--output') ?? join(buildRoot, 'certification'))
await run([
  process.execPath,
  join(repositoryRoot, 'packages', 'test-harness', 'src', 'run-release-certification.ts'),
  '--archive',
  archive,
  '--manifest',
  manifest,
  '--manifest-sha256',
  manifestSha256,
  '--output',
  output,
])
