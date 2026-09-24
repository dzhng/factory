import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const dockerOutput = await mkdtemp(join(tmpdir(), 'factory-review-plan-'))
const child = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=512m',
    '--mount',
    `type=bind,src=${root},dst=/workspace,readonly`,
    '--mount',
    `type=bind,src=${dockerOutput},dst=/output`,
    '--workdir',
    '/workspace',
    'oven/bun:1.3.14',
    'bun',
    'run',
    'packages/test-harness/src/review-plan-worker.ts',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
let status = await child.exited
if (status === 0) {
  const gitProbe = Bun.spawnSync([
    'git',
    '-C',
    join(dockerOutput, 'reconstructed'),
    'rev-parse',
    '--show-toplevel',
  ])
  if (gitProbe.exitCode === 0) {
    console.error('fresh reconstruction unexpectedly discovered Git metadata')
    status = 1
  }
}
await rm(join(dockerOutput, 'reconstructed'), { recursive: true, force: true })
process.stdout.write(`Review plan workbench: ${dockerOutput}\n`)
process.exit(status)
