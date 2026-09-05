import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const outputRoot = `${repositoryRoot}/specs/done/factory-v1/assets/git-observation-workbench`
const image = 'factory-git-observation-test:local'
await mkdir(outputRoot, { recursive: true })

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
    '/tmp:rw,nosuid,nodev,size=128m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--mount',
    `type=bind,src=${outputRoot},dst=/output`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    image,
    'bun',
    'run',
    '/workspace/packages/repository/test/git-observation-report.ts',
    '/output',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
const exitCode = await child.exited
if (exitCode !== 0) process.exit(exitCode)
process.stdout.write(`Git observation workbench: ${outputRoot}/index.html\n`)
