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
    '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    'oven/bun:1.3.14',
    'bun',
    'test',
    '/workspace/packages/review-plan/test/bundle.test.ts',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exit(await child.exited)
