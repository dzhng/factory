const repositoryRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const child = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    '1000:1000',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    'oven/bun:1.3.14',
    'bun',
    'test',
    '/workspace/packages/reviewer/test/environment-docker.test.ts',
    '/workspace/packages/reviewer/test/isolation-docker.test.ts',
    '/workspace/packages/reviewer/test/submissions-docker.test.ts',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exit(await child.exited)
