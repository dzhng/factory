import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const child = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=256m',
    '--tmpfs',
    '/disk-full:rw,noexec,nosuid,nodev,size=1m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    '--env',
    'FACTORY_DISK_FULL_ROOT=/disk-full',
    'oven/bun:1.3.14',
    'bun',
    'test',
    '/workspace/packages/runtime-journal/test/journal.test.ts',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exit(await child.exited)
