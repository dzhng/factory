const repositoryRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const image = 'factory-capture-test:local'
let child = Bun.spawn(['bun', 'run', '--cwd', 'packages/cli', 'build'], {
  cwd: repositoryRoot,
  stdout: 'inherit',
  stderr: 'inherit',
})
if ((await child.exited) !== 0) process.exit(1)
child = Bun.spawn(
  [
    'docker',
    'build',
    '--network',
    'none',
    '--tag',
    image,
    '--file',
    `${repositoryRoot}/packages/cli/test/Dockerfile`,
    repositoryRoot,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
if ((await child.exited) !== 0) process.exit(1)
child = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,size=256m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    image,
    'bun',
    'test',
    '/workspace/packages/cli/test/vertical.test.ts',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exit(await child.exited)
