import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const outputRoot = `${repositoryRoot}/specs/factory-v1/assets/repository-workbench`
await mkdir(outputRoot, { recursive: true })

const child = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--mount',
    `type=bind,src=${outputRoot},dst=/output`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    'oven/bun:1.3.11',
    'bun',
    'run',
    '/workspace/packages/repository/test/workbench-report.ts',
    '/output',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
const exitCode = await child.exited
if (exitCode !== 0) process.exit(exitCode)
process.stdout.write(`Repository workbench: ${outputRoot}/index.html\n`)
