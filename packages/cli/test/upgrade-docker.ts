const repositoryRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
async function run(image: string, test: string): Promise<number> {
  const child = Bun.spawn(
    [
      'docker',
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,nodev,size=64m',
      '--mount',
      `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
      '--workdir',
      '/tmp',
      '--env',
      'FACTORY_DOCKER_TEST=1',
      image,
      'bun',
      'test',
      `/workspace/packages/cli/test/${test}`,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  return await child.exited
}

let code = await run('oven/bun:1.3.11', 'upgrade.test.ts')
if (code === 0) code = await run('oven/bun:1.3.11-alpine', 'release-target.test.ts')
process.exit(code)
