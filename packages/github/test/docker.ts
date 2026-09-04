const image = 'oven/bun:1.3.11'
const repositoryRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const child = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=128m',
    '--tmpfs',
    '/runtime:rw,noexec,nosuid,nodev,size=32m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    image,
    'bun',
    'test',
    '/workspace/packages/github/test/workbench.test.ts',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exit(await child.exited)
