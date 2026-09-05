import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const result = Bun.spawnSync(
  [
    'docker',
    'run',
    '--rm',
    '--read-only',
    '--network=none',
    '--tmpfs',
    '/state:rw,noexec,nosuid,size=32m',
    '--mount',
    `type=bind,src=${packageRoot},dst=/workspace,readonly`,
    '--workdir',
    '/workspace',
    'oven/bun:1.3.14',
    'bun',
    'docker/provider-process-probe.ts',
  ],
  { stderr: 'pipe', stdout: 'pipe' },
)
if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
const output = new TextDecoder().decode(result.stdout)
JSON.parse(output)
await writeFile(`${packageRoot}/fixtures/provider-process-probe.json`, output, 'utf8')
process.stdout.write(output)
