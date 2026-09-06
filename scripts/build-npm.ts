import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { verifyReleaseArtifact } from '../packages/cli/src/release-manifest'

function option(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const version = option('--version')
const revision = option('--revision')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('invalid version')
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('invalid revision')
const artifacts = resolve(option('--artifacts'))
const output = resolve(option('--output'))
const targets = ['bun-darwin-arm64', 'bun-linux-x64-baseline'] as const
const verified = await Promise.all(
  targets.map(async target => {
    const stem = `factory-v${version}-${target.slice(4)}`
    const archive = await readFile(join(artifacts, `${stem}.tar.gz`))
    const adjacentManifest = await readFile(join(artifacts, `${stem}.json`))
    // The workflow supplies artifacts from this exact source run; verification
    // checks their complete inventory before repackaging, not registry authority.
    const release = await verifyReleaseArtifact({
      archive,
      adjacentManifest,
      expectedManifestSha256: createHash('sha256').update(adjacentManifest).digest('hex'),
      expectedTarget: target,
    })
    if (release.version !== version || release.revision !== revision) {
      throw new Error('npm package and native release identity mismatch')
    }
    return { target, archive }
  }),
)

await mkdir(output)
for (const { target, archive } of verified) {
  const destination = join(output, 'native', target.slice(4))
  await mkdir(destination, { recursive: true })
  await new Bun.Archive(archive).extract(destination)
  await chmod(join(destination, 'factory'), 0o755)
}
await mkdir(join(output, 'bin'))
await copyFile(join(import.meta.dir, 'npm-launcher.cjs'), join(output, 'bin/factory.cjs'))
await chmod(join(output, 'bin/factory.cjs'), 0o755)
await copyFile(join(import.meta.dir, '../LICENSE'), join(output, 'LICENSE'))
await copyFile(join(import.meta.dir, '../SECURITY.md'), join(output, 'SECURITY.md'))
await copyFile(join(import.meta.dir, 'npm-README.md'), join(output, 'README.md'))
await writeFile(
  join(output, 'package.json'),
  `${JSON.stringify(
    {
      name: '@dzhng/factory',
      version,
      description: 'Local Codex and Claude session capture, isolated review, and decision history',
      license: 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/dzhng/factory.git' },
      bin: { factory: 'bin/factory.cjs' },
      files: ['bin', 'native', 'LICENSE', 'README.md', 'SECURITY.md'],
      engines: { node: '>=22' },
      os: ['darwin', 'linux'],
      cpu: ['arm64', 'x64'],
      publishConfig: { access: 'public' },
    },
    null,
    2,
  )}\n`,
)
