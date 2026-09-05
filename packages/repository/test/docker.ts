// The workbench needs Bun, not production runtime authority. Keep this aligned
// with the pinned local image used when registry access is unavailable.
const image = 'oven/bun:1.3.14'
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
    '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--tmpfs',
    '/runtime:rw,noexec,nosuid,nodev,size=16m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    image,
    'bun',
    'test',
    '/workspace/packages/repository/test/workbench.test.ts',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exit(await child.exited)
