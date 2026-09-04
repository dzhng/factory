import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const dockerRoot = `${packageRoot}/docker/provider-clients`
const image = 'factory-provider-client-oracle:codex-0.144.4-claude-2.1.260'

function run(arguments_: string[]): string {
  const result = Bun.spawnSync(arguments_, { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
  return new TextDecoder().decode(result.stdout)
}

run([
  'docker',
  'build',
  '--build-arg',
  'CODEX_VERSION=0.144.4',
  '--build-arg',
  'CLAUDE_VERSION=2.1.260',
  '--tag',
  image,
  dockerRoot,
])
const output = run([
  'docker',
  'run',
  '--rm',
  '--read-only',
  '--network=none',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,size=32m',
  image,
])
JSON.parse(output)
await writeFile(`${packageRoot}/fixtures/provider-client-inventory.json`, output, 'utf8')
process.stdout.write(output)
