const repositoryRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const image = 'factory-git-observation-test:local'

let child = Bun.spawn(
  [
    'docker',
    'build',
    '--network',
    'none',
    '--tag',
    image,
    '--file',
    `${repositoryRoot}/packages/repository/test/git.Dockerfile`,
    repositoryRoot,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
if ((await child.exited) !== 0) globalThis.process.exit(1)

child = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,size=128m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    image,
    'bun',
    'test',
    '/workspace/packages/repository/test/confined-writer.test.ts',
    '/workspace/packages/repository/test/git-observation.test.ts',
    '/workspace/packages/repository/test/sanitization.test.ts',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
globalThis.process.exit(await child.exited)
