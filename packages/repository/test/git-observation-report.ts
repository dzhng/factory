import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalJson } from '../../contract/src/index'
import { GitObserver } from '../src/git-observer'
import { MemoryGitObjectStore } from './git-object-store'

if (process.env.FACTORY_DOCKER_TEST !== '1') throw new Error('Git workbench requires Docker')
const outputRoot = process.argv[2]
if (outputRoot === undefined) throw new Error('Git workbench requires an output directory')

async function git(root: string, args: readonly string[]): Promise<Uint8Array> {
  const child = Bun.spawn(['git', ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      GIT_OPTIONAL_LOCKS: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stderr)
  return new Uint8Array(stdout)
}

async function fixtureSentinel(root: string, paths: readonly string[]): Promise<string> {
  const state = createHash('sha256')
  for (const args of [
    ['rev-parse', 'HEAD'],
    ['symbolic-ref', '-q', 'HEAD'],
    ['for-each-ref', '--format=%(refname)%00%(objectname)'],
    ['config', '--local', '--null', '--list'],
  ])
    state.update(await git(root, args))
  state.update(await readFile(join(root, '.git', 'index')))
  for (const path of paths) {
    const entry = await lstat(join(root, path))
    state.update(path).update(String(entry.mode))
    state.update(
      entry.isSymbolicLink()
        ? await readlink(join(root, path), { encoding: 'buffer' })
        : await readFile(join(root, path)),
    )
  }
  return state.digest('hex')
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'factory-git-lab-'))
  await git(root, ['init', '--quiet', '--initial-branch=main'])
  await git(root, ['config', 'user.name', 'Factory Lab'])
  await git(root, ['config', 'user.email', 'factory@example.invalid'])
  return root
}

const ordinaryRoot = await fixture()
const racedRoot = await fixture()
try {
  await writeFile(join(ordinaryRoot, '.env'), 'TOKEN=synthetic-workbench-secret\n')
  await writeFile(
    join(ordinaryRoot, 'README.txt'),
    'Reasoning remains; synthetic-workbench-secret is removed.\n',
  )
  await writeFile(join(ordinaryRoot, 'run.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(ordinaryRoot, 'run.sh'), 0o755)
  await symlink('README.txt', join(ordinaryRoot, 'readme-link'))
  await writeFile(join(ordinaryRoot, '.gitignore'), 'ignored.log\n')
  await writeFile(join(ordinaryRoot, 'ignored.log'), 'excluded\n')
  await git(ordinaryRoot, ['add', '-A'])
  await git(ordinaryRoot, ['commit', '--quiet', '-m', 'ordinary'])
  await writeFile(join(ordinaryRoot, 'new.bin'), new Uint8Array([0, 255, 1]))
  const sentinelBefore = await fixtureSentinel(ordinaryRoot, [
    '.gitignore',
    'README.txt',
    'new.bin',
    'readme-link',
    'run.sh',
  ])
  const ordinaryObjects = new MemoryGitObjectStore()
  const ordinaryObserver = new GitObserver(ordinaryRoot, ordinaryObjects, {
    repositoryId: 'repo_git_workbench',
    now: () => new Date('2026-09-04T00:00:00Z'),
  })
  const ordinary = await ordinaryObserver.observe()
  if (ordinary.kind !== 'observed') throw new Error('ordinary fixture did not observe exactly')
  const ordinaryManifest = await ordinaryObjects.readJson(ordinary.observation.codeManifest!)
  const reconstruction = await mkdtemp(join(tmpdir(), 'factory-git-reconstruction-'))
  try {
    await ordinaryObserver.reconstruct(ordinaryManifest, reconstruction)
    const reconstructed = ordinaryManifest.entries.map(entry => ({
      path: entry.path.display ?? `base64:${entry.path.bytes}`,
      kind: entry.kind,
      mode: entry.mode,
      sha256: entry.kind === 'gitlink' ? entry.gitObject : entry.object?.sha256,
    }))
    const sentinelAfter = await fixtureSentinel(ordinaryRoot, [
      '.gitignore',
      'README.txt',
      'new.bin',
      'readme-link',
      'run.sh',
    ])

    await writeFile(join(racedRoot, 'source.ts'), 'before\n')
    await git(racedRoot, ['add', 'source.ts'])
    await git(racedRoot, ['commit', '--quiet', '-m', 'race'])
    const raced = await new GitObserver(racedRoot, new MemoryGitObjectStore(), {
      repositoryId: 'repo_git_workbench',
      now: () => new Date('2026-09-04T00:00:00Z'),
      afterCapture: async () => writeFile(join(racedRoot, 'source.ts'), 'after\n'),
    }).observe()
    if (raced.kind !== 'raced') throw new Error('raced fixture did not report a race')

    const report = {
      schemaVersion: 1,
      ordinary: {
        disposition: ordinary.kind,
        git: {
          branch: ordinary.observation.git.branch,
          detached: ordinary.observation.git.detached,
          head: ordinary.observation.git.head,
          indexPresent: ordinary.observation.git.index !== undefined,
        },
        paths: ordinaryManifest.entries.map(
          entry => entry.path.display ?? `base64:${entry.path.bytes}`,
        ),
        limitations: ordinaryManifest.limitations,
        transformation: ordinaryManifest.transformation,
        sanitizedSource: await readFile(join(reconstruction, 'README.txt'), 'utf8'),
        reconstruction: reconstructed,
        sentinel: {
          observationStable: ordinary.observation.startState === ordinary.observation.endState,
          refsConfigIndexAndWorktreeStable: sentinelBefore === sentinelAfter,
        },
      },
      raced: {
        disposition: raced.kind,
        race: {
          code: raced.race.code,
          stateChanged: raced.race.startState !== raced.race.endState,
        },
        limitations: raced.partial.limitations,
      },
    }
    if (
      !report.ordinary.sentinel.observationStable ||
      !report.ordinary.sentinel.refsConfigIndexAndWorktreeStable
    ) {
      throw new Error('ordinary Git observation mutated its subject')
    }
    if (
      report.ordinary.sanitizedSource !== 'Reasoning remains; [REDACTED] is removed.\n' ||
      report.ordinary.paths.includes('.env') ||
      report.ordinary.paths.includes('new.bin')
    )
      throw new Error('source evidence did not follow the sanitization contract')
    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, 'report.json'), canonicalJson(report))
    const escaped = canonicalJson(report)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
    await writeFile(
      join(outputRoot, 'index.html'),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Factory Git observation workbench</title><style>body{font:15px/1.45 system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem;background:#111719;color:#e6efed}h1{color:#9ee7d7}pre{white-space:pre-wrap;background:#192326;border:1px solid #344448;border-radius:10px;padding:1rem}.ok{color:#83e377}</style></head><body><h1>Safe Git observation</h1><p class="ok">Ordinary reconstruction is stable; the mutation fixture is typed as raced.</p><pre>${escaped}</pre></body></html>\n`,
    )
    process.stdout.write(`${canonicalJson(report)}`)
  } finally {
    await rm(reconstruction, { recursive: true, force: true })
  }
} finally {
  await Promise.all(
    [ordinaryRoot, racedRoot].map(root => rm(root, { recursive: true, force: true })),
  )
}
