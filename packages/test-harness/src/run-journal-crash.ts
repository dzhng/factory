import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const outputRoot = join(repositoryRoot, 'specs', 'factory-v1', 'assets', 'journal-crash')
await mkdir(outputRoot, { recursive: true })

let nodeSmoke = 'unavailable: exact Node 22 image was not locally available'
let linkedWorktreeSmoke = 'unavailable'
const build = Bun.spawn(['bun', 'run', '--cwd', 'packages/runtime-journal', 'build'], {
  cwd: repositoryRoot,
  stdout: 'pipe',
  stderr: 'pipe',
})
const buildExit = await build.exited
if (buildExit !== 0) {
  process.stderr.write(await new Response(build.stderr).text())
  process.exit(buildExit)
}
{
  const smokeRoot = await mkdtemp(join(tmpdir(), 'factory-node-smoke-'))
  const script = `import('${repositoryRoot}/packages/runtime-journal/dist/index.js').then(async m=>{const j=await m.openRuntimeJournal({testRuntimeRoot:${JSON.stringify(smokeRoot)}});await j.append({provider:'codex',sessionId:'node',generation:0,eventId:'one',eventKind:'turn',occurredAt:'2026-09-04T00:00:00Z',raw:new TextEncoder().encode('node')})})`
  const node = Bun.spawn(['node', '--input-type=module', '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const version = Bun.spawnSync(['node', '--version']).stdout.toString().trim()
  nodeSmoke =
    (await node.exited) === 0
      ? `pass on host Node ${version}; exact Node 22 unavailable`
      : `failed on host Node ${version}`
}

{
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'factory-linked-smoke-'))
  const main = join(fixtureRoot, 'main')
  const linked = join(fixtureRoot, 'linked')
  await mkdir(main)
  const git = (args: string[], cwd = main) =>
    Bun.spawnSync(['git', ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Factory Lab',
        GIT_AUTHOR_EMAIL: 'factory@example.invalid',
        GIT_COMMITTER_NAME: 'Factory Lab',
        GIT_COMMITTER_EMAIL: 'factory@example.invalid',
      },
    })
  if (git(['init']).exitCode === 0) {
    await writeFile(join(main, 'README.md'), 'linked-worktree fixture\n')
    const prepared =
      git(['add', 'README.md']).exitCode === 0 &&
      git(['commit', '-m', 'fixture']).exitCode === 0 &&
      git(['worktree', 'add', '-b', 'feature', linked]).exitCode === 0
    if (prepared) {
      const script = `import('${repositoryRoot}/packages/runtime-journal/dist/index.js').then(async m=>{const a=await m.openRuntimeJournal({repositoryRoot:${JSON.stringify(main)}});const b=await m.openRuntimeJournal({repositoryRoot:${JSON.stringify(linked)}});await Promise.all([a.append({provider:'codex',sessionId:'linked',generation:0,eventId:'a',eventKind:'turn',occurredAt:'2026-09-04T00:00:00Z',raw:new TextEncoder().encode('a')}),b.append({provider:'codex',sessionId:'linked',generation:0,eventId:'b',eventKind:'turn',occurredAt:'2026-09-04T00:00:00Z',raw:new TextEncoder().encode('b')})]);if((await a.inventory()).referenced.length!==2)process.exit(1)})`
      const node = Bun.spawn(['node', '--input-type=module', '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      linkedWorktreeSmoke =
        (await node.exited) === 0 ? 'pass with real Git linked worktree' : 'failed'
    }
  }
}

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
    '/disk-full:rw,noexec,nosuid,nodev,size=1m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--mount',
    `type=bind,src=${outputRoot},dst=/output`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    '--env',
    'FACTORY_DISK_FULL_ROOT=/disk-full',
    '--env',
    `FACTORY_NODE_SMOKE=${nodeSmoke}`,
    '--env',
    `FACTORY_LINKED_SMOKE=${linkedWorktreeSmoke}`,
    'oven/bun:1.3.14',
    'bun',
    'run',
    '/workspace/packages/runtime-journal/test/lab-report.ts',
    '/output',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exitCode = await child.exited
if (process.exitCode === 0) process.stdout.write(`Journal crash lab: ${outputRoot}/index.html\n`)
