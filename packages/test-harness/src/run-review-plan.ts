import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const output = resolve(root, 'specs/factory-v1/assets/review-plan')
const dockerOutput = await mkdtemp(join(dirname(root), 'factory-review-plan-output-'))
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
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
    'oven/bun:1.3.11',
    'bun',
    'run',
    'packages/test-harness/src/review-plan-worker.ts',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
const status = await child.exited
if (status === 0) await cp(dockerOutput, output, { recursive: true })
await rm(dockerOutput, { recursive: true, force: true })
process.exit(status)
