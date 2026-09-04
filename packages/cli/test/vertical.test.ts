import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.FACTORY_DOCKER_TEST !== '1') {
  throw new Error('capture vertical tests must run in the project Docker environment')
}

const roots: string[] = []
afterEach(() => {
  roots.length = 0
})

async function command(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  stdin?: string,
) {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env,
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

async function git(root: string, ...args: string[]) {
  const result = await command('git', args, root, { ...process.env, HOME: join(root, '.home') })
  if (result.code !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'factory-capture-'))
  roots.push(root)
  const home = join(root, 'home')
  const repository = join(root, 'repository')
  const bin = join(root, 'bin')
  await Promise.all([
    mkdir(join(home, '.codex', 'sessions'), { recursive: true }),
    mkdir(join(home, '.claude', 'projects'), { recursive: true }),
    mkdir(repository),
    mkdir(bin),
  ])
  const factory = join(bin, 'factory')
  await writeFile(factory, '#!/bin/sh\nexec bun /workspace/packages/cli/dist/factory.js "$@"\n')
  await chmod(factory, 0o755)
  await git(repository, 'init', '-b', 'main')
  await git(repository, 'config', 'user.email', 'factory@example.invalid')
  await git(repository, 'config', 'user.name', 'Factory Test')
  await writeFile(join(repository, 'app.ts'), 'export const value = 1\n')
  await git(repository, 'add', 'app.ts')
  await git(repository, 'commit', '-m', 'fixture')
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.state'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PATH: `${bin}:${process.env.PATH}`,
  }
  return { root, home, repository, factory, env }
}

async function replay(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  provider: 'codex' | 'claude',
): Promise<Record<string, unknown>[]> {
  const source = `/workspace/packages/test-harness/fixtures/providers/${provider}/hooks.jsonl`
  const transcript = join(
    fixture.home,
    provider === 'codex' ? '.codex/sessions/transcript.jsonl' : '.claude/projects/transcript.jsonl',
  )
  await cp(
    `/workspace/packages/test-harness/fixtures/providers/${provider}/transcript.jsonl`,
    transcript,
  )
  const rows = (await readFile(source, 'utf8'))
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line))
  for (const value of rows.filter(value =>
    [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ].includes(value.hook_event_name),
  )) {
    value.cwd = fixture.repository
    if (value.transcript_path !== undefined) value.transcript_path = transcript
    const config = JSON.parse(
      await readFile(
        join(fixture.home, provider === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'),
        'utf8',
      ),
    )
    const hook = config.hooks[value.hook_event_name].at(-1).hooks[0]
    const result =
      provider === 'codex'
        ? await command(
            '/bin/sh',
            ['-c', hook.command],
            fixture.repository,
            fixture.env,
            `${JSON.stringify(value)}\n`,
          )
        : await command(
            hook.command,
            hook.args,
            fixture.repository,
            fixture.env,
            `${JSON.stringify(value)}\n`,
          )
    expect(result).toMatchObject({ code: 0, stdout: '{}\n' })
  }
  return rows
}

async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (directory: string, relative = ''): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const item = await lstat(path)
      const key = relative === '' ? name : `${relative}/${name}`
      hash.update(key)
      if (item.isDirectory()) await visit(path, key)
      else hash.update(await readFile(path))
    }
  }
  await visit(root)
  return hash.digest('hex')
}

describe('installed capture vertical', () => {
  test('initializes, installs direct hooks, materializes both providers, and rebuilds projection', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    expect(
      (
        await command(
          value.factory,
          ['install', '--executable', value.factory],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)
    const codexHooks = JSON.parse(await readFile(join(value.home, '.codex', 'hooks.json'), 'utf8'))
    const claudeHooks = JSON.parse(
      await readFile(join(value.home, '.claude', 'settings.json'), 'utf8'),
    )
    expect(codexHooks.hooks.Stop).toHaveLength(1)
    expect(claudeHooks.hooks.Stop).toHaveLength(1)

    const gitHeadBefore = await git(value.repository, 'rev-parse', 'HEAD')
    const gitIndexBefore = await git(value.repository, 'write-tree')
    const codexRows = await replay(value, 'codex')
    await replay(value, 'claude')

    const repeatedStop = codexRows.find(row => row.hook_event_name === 'Stop')!
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        `${JSON.stringify(repeatedStop)}\n`,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })

    const doctor = await command(value.factory, ['doctor'], value.repository, value.env)
    expect(doctor.code).toBe(0)
    const report = JSON.parse(doctor.stdout)
    expect(report.repository).toBe('ok')
    expect(
      report.projection.sessions.map((session: { provider: string }) => session.provider),
    ).toEqual(['claude', 'codex'])
    expect(report.projection.triggers).toBe(2)
    expect(report.projection.issues).toEqual([])
    for (const session of report.projection.sessions) {
      const turns = join(
        value.repository,
        '.factory',
        'sessions',
        session.provider,
        session.sessionKey,
        'turns',
      )
      const turnId = (await readdir(turns))[0]!
      const manifest = JSON.parse(await readFile(join(turns, turnId, 'manifest.json'), 'utf8'))
      expect(manifest.limitations).toContainEqual({
        code: 'missing-transcript-range',
        detail: 'provider transcript lags the Stop assistant message',
      })
    }
    expect(await git(value.repository, 'rev-parse', 'HEAD')).toBe(gitHeadBefore)
    expect(await git(value.repository, 'write-tree')).toBe(gitIndexBefore)
    const providers = await readdir(join(value.repository, '.factory', 'sessions'))
    expect(providers.sort()).toEqual(['claude', 'codex'])
    const factoryDigest = await treeDigest(join(value.repository, '.factory'))
    const commonBeforeDoctor = await git(
      value.repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    )
    const runtimeRoot = join(commonBeforeDoctor, 'factory-runtime')
    const runtimeDigest = await treeDigest(runtimeRoot)
    const providerDigest = await treeDigest(value.home)
    const readOnlyDoctor = await command(value.factory, ['doctor'], value.repository, value.env)
    expect(readOnlyDoctor.code).toBe(0)
    expect(await treeDigest(join(value.repository, '.factory'))).toBe(factoryDigest)
    expect(await treeDigest(runtimeRoot)).toBe(runtimeDigest)
    expect(await treeDigest(value.home)).toBe(providerDigest)
    const common = await git(
      value.repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    )
    const journal = join(common, 'factory-runtime', 'journal-v1', 'journal.sqlite')
    const database = new Database(journal)
    database.run('DROP INDEX events_by_session_sequence')
    database.close(false)
    const rebuilt = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(rebuilt.projection).toEqual(report.projection)
    if (process.env.FACTORY_EVIDENCE_ROOT !== undefined) {
      await cp(
        join(value.repository, '.factory'),
        join(process.env.FACTORY_EVIDENCE_ROOT, '.factory'),
        {
          recursive: true,
        },
      )
      const evidenceReport = structuredClone(rebuilt)
      if (evidenceReport.hooks !== null && evidenceReport.hooks.error === undefined) {
        evidenceReport.hooks.executable = '<packaged-fixture>'
        for (const provider of ['codex', 'claude']) {
          if (evidenceReport.hooks.providers[provider] !== undefined) {
            evidenceReport.hooks.providers[provider] = {
              path:
                provider === 'codex'
                  ? '$CODEX_HOME/hooks.json'
                  : '$CLAUDE_CONFIG_DIR/settings.json',
              installedEvents: evidenceReport.hooks.providers[provider].fingerprints.length,
            }
          }
        }
      }
      await writeFile(
        join(process.env.FACTORY_EVIDENCE_ROOT, 'rebuild-report.json'),
        `${JSON.stringify(evidenceReport, null, 2)}\n`,
      )
    }
    expect((await command(value.factory, ['uninstall'], value.repository, value.env)).code).toBe(0)
    expect(
      JSON.parse(await readFile(join(value.home, '.codex', 'hooks.json'), 'utf8')).hooks.Stop,
    ).toEqual([])
  }, 30_000)

  test('keeps a continuing Session in its first repository across branch and repository changes', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const transcript = join(value.home, '.codex', 'sessions', 'continued.jsonl')
    await writeFile(transcript, '{"type":"message"}\n')
    const send = async (repository: string, payload: Record<string, unknown>) => {
      const result = await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        repository,
        value.env,
        `${JSON.stringify({ session_id: 'continued', cwd: repository, ...payload })}\n`,
      )
      expect(result).toMatchObject({ code: 0, stdout: '{}\n' })
    }
    await send(value.repository, { hook_event_name: 'SessionStart' })
    await send(value.repository, {
      hook_event_name: 'Stop',
      turn_id: 'stop-1',
      transcript_path: transcript,
    })
    await git(value.repository, 'checkout', '-b', 'feature')
    await send(value.repository, { hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2' })
    await send(value.repository, {
      hook_event_name: 'Stop',
      turn_id: 'stop-2',
      transcript_path: transcript,
    })
    const other = join(value.root, 'other-repository')
    await mkdir(other)
    await git(other, 'init', '-b', 'main')
    await send(other, { hook_event_name: 'UserPromptSubmit', turn_id: 'turn-3' })
    await send(other, {
      hook_event_name: 'Stop',
      turn_id: 'stop-3',
      transcript_path: transcript,
    })

    const report = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(report.projection.sessions).toHaveLength(1)
    expect(report.projection.sessions[0].turns).toBe(3)
    const sessionRoot = join(
      value.repository,
      '.factory',
      'sessions',
      'codex',
      report.projection.sessions[0].sessionKey,
      'turns',
    )
    const manifests = await Promise.all(
      (await readdir(sessionRoot)).map(id =>
        readFile(join(sessionRoot, id, 'manifest.json'), 'utf8').then(JSON.parse),
      ),
    )
    expect(manifests.some(manifest => manifest.branch === 'feature')).toBeTrue()
    expect(
      manifests.some(manifest =>
        manifest.limitations.some(
          (limitation: { code: string }) => limitation.code === 'cross-repository-session',
        ),
      ),
    ).toBeTrue()
    expect(await pathExists(join(other, '.factory'))).toBeFalse()
  }, 30_000)

  test('requires plaintext acknowledgement for global automatic initialization', async () => {
    const value = await createFixture()
    const refused = await command(
      value.factory,
      ['configure', '--global', '--repository-initialization', 'automatic'],
      value.repository,
      value.env,
    )
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('acknowledge-plaintext-evidence')
    expect(
      (
        await command(
          value.factory,
          [
            'configure',
            '--global',
            '--repository-initialization',
            'automatic',
            '--acknowledge-plaintext-evidence',
            '--canonical-branch',
            'main',
          ],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)

    const secondRepository = join(value.root, 'automatic-repository')
    await mkdir(secondRepository)
    await git(secondRepository, 'init', '-b', 'main')
    await git(secondRepository, 'config', 'user.email', 'factory@example.invalid')
    await git(secondRepository, 'config', 'user.name', 'Factory Test')
    await writeFile(join(secondRepository, 'code.ts'), 'export {}\n')
    await git(secondRepository, 'add', 'code.ts')
    await git(secondRepository, 'commit', '-m', 'fixture')
    const transcript = join(value.home, '.codex', 'sessions', 'automatic.jsonl')
    await writeFile(transcript, '{"type":"message"}\n')
    for (const payload of [
      {
        session_id: 'automatic-session',
        hook_event_name: 'SessionStart',
        cwd: secondRepository,
      },
      {
        session_id: 'automatic-session',
        turn_id: 'automatic-stop',
        hook_event_name: 'Stop',
        cwd: secondRepository,
        transcript_path: transcript,
      },
    ]) {
      const captured = await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        secondRepository,
        value.env,
        `${JSON.stringify(payload)}\n`,
      )
      expect(captured).toMatchObject({ code: 0, stdout: '{}\n' })
    }
    expect(
      JSON.parse(await readFile(join(secondRepository, '.factory', 'config.json'), 'utf8')),
    ).toMatchObject({
      canonicalBranch: 'main',
    })
  })

  test('recovers interrupted hook installation without losing foreign hooks', async () => {
    const value = await createFixture()
    const codexPath = join(value.home, '.codex', 'hooks.json')
    const foreign = {
      future: true,
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/foreign' }] }] },
    }
    await writeFile(codexPath, `${JSON.stringify(foreign)}\n`)
    const crashed = await command(
      value.factory,
      ['install', '--executable', value.factory],
      value.repository,
      { ...value.env, FACTORY_TEST_HOOK_CRASH: 'after-config' },
    )
    expect(crashed.code).toBe(1)
    expect(
      (
        await command(
          value.factory,
          ['install', '--executable', value.factory],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)
    const installed = JSON.parse(await readFile(codexPath, 'utf8'))
    expect(installed.future).toBeTrue()
    expect(installed.hooks.Stop[0]).toEqual(foreign.hooks.Stop[0])
    expect(installed.hooks.Stop).toHaveLength(2)

    const afterJournal = await command(
      value.factory,
      ['install', '--executable', value.factory],
      value.repository,
      { ...value.env, FACTORY_TEST_HOOK_CRASH: 'after-journal' },
    )
    expect(afterJournal.code).toBe(1)
    expect(
      (
        await command(
          value.factory,
          ['install', '--executable', value.factory],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)

    const beforeEdit = JSON.parse(await readFile(codexPath, 'utf8'))
    const edited = structuredClone(beforeEdit)
    edited.hooks.Stop.at(-1).hooks[0].command += ' # user edit'
    await writeFile(codexPath, `${JSON.stringify(edited)}\n`)
    expect((await command(value.factory, ['uninstall'], value.repository, value.env)).code).toBe(0)
    const afterUninstall = JSON.parse(await readFile(codexPath, 'utf8'))
    expect(afterUninstall.hooks.Stop).toContainEqual(edited.hooks.Stop.at(-1))
  })

  test('provider hook remains fail-open when its installed executable crashes', async () => {
    const value = await createFixture()
    const failing = join(value.root, 'bin', "factory failing 'quoted'")
    await writeFile(failing, '#!/bin/sh\nprintf partial\nexit 9\n')
    await chmod(failing, 0o755)
    expect(
      (
        await command(
          value.factory,
          ['install', '--executable', failing],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)
    const hooks = JSON.parse(await readFile(join(value.home, '.codex', 'hooks.json'), 'utf8'))
    const script = hooks.hooks.Stop[0].hooks[0].command
    expect(
      await command('/bin/sh', ['-c', script], value.repository, value.env, '{}\n'),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
  })

  test('keeps forged or unavailable transcript input partial without leaking its path', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const payload = {
      session_id: 'forged-transcript',
      turn_id: 'partial-stop',
      hook_event_name: 'Stop',
      cwd: value.repository,
      transcript_path: '/etc/passwd',
    }
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        `${JSON.stringify(payload)}\n`,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const report = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(report.projection.triggers).toBe(1)
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('/etc/passwd')
    const session = report.projection.sessions[0]
    const turnRoot = join(
      value.repository,
      '.factory',
      'sessions',
      'codex',
      session.sessionKey,
      'turns',
    )
    const turnId = (await readdir(turnRoot))[0]!
    const manifest = JSON.parse(await readFile(join(turnRoot, turnId, 'manifest.json'), 'utf8'))
    expect(manifest.limitations).toContainEqual({
      code: 'missing-transcript-range',
      detail: 'provider transcript path is outside its configured home',
    })
  })

  test('leaves a claimed Stop recoverable while .factory has unresolved index entries', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const left = (
      await command('git', ['hash-object', '-w', '--stdin'], value.repository, value.env, 'left\n')
    ).stdout.trim()
    const right = (
      await command('git', ['hash-object', '-w', '--stdin'], value.repository, value.env, 'right\n')
    ).stdout.trim()
    const conflict = `100644 ${left} 1\t.factory/config.json\n100644 ${left} 2\t.factory/config.json\n100644 ${right} 3\t.factory/config.json\n`
    expect(
      (
        await command(
          'git',
          ['update-index', '--index-info'],
          value.repository,
          value.env,
          conflict,
        )
      ).code,
    ).toBe(0)
    const indexBefore = await git(value.repository, 'ls-files', '-u', '--', '.factory')
    const payload = {
      session_id: 'conflicted-factory',
      turn_id: 'conflicted-stop',
      hook_event_name: 'Stop',
      cwd: value.repository,
    }
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        `${JSON.stringify(payload)}\n`,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const report = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(report.pendingStops).toBe(1)
    expect(report.projection.triggers).toBe(0)
    expect(await git(value.repository, 'ls-files', '-u', '--', '.factory')).toBe(indexBefore)
    expect(
      (
        await command(
          'git',
          ['update-index', '--force-remove', '.factory/config.json'],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        `${JSON.stringify({ session_id: 'conflicted-factory', hook_event_name: 'SessionEnd', cwd: value.repository })}\n`,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const resumed = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(resumed.pendingStops).toBe(0)
    expect(resumed.projection.triggers).toBe(1)
  })

  test('does not publish an interrupted Turn prefix while .factory is conflicted', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const payload = {
      session_id: 'prefix-conflict',
      turn_id: 'prefix-stop',
      hook_event_name: 'Stop',
      cwd: value.repository,
    }
    await command(
      value.factory,
      ['capture', '--provider', 'codex'],
      value.repository,
      value.env,
      `${JSON.stringify(payload)}\n`,
    )
    const triggerRoot = join(value.repository, '.factory', 'review-triggers')
    await unlink(join(triggerRoot, (await readdir(triggerRoot))[0]!))
    const common = await git(
      value.repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    )
    const database = new Database(join(common, 'factory-runtime', 'journal-v1', 'journal.sqlite'))
    database.run('DELETE FROM completions')
    database.close(false)
    const blob = (
      await command(
        'git',
        ['hash-object', '-w', '--stdin'],
        value.repository,
        value.env,
        'conflict\n',
      )
    ).stdout.trim()
    const conflict = `100644 ${blob} 1\t.factory/config.json\n100644 ${blob} 2\t.factory/config.json\n100644 ${blob} 3\t.factory/config.json\n`
    await command('git', ['update-index', '--index-info'], value.repository, value.env, conflict)
    await command(
      value.factory,
      ['capture', '--provider', 'codex'],
      value.repository,
      value.env,
      `${JSON.stringify({ session_id: 'prefix-conflict', hook_event_name: 'SessionEnd', cwd: value.repository })}\n`,
    )
    expect(await readdir(triggerRoot)).toEqual([])
  })
})

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
