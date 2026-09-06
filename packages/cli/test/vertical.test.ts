import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalJson, type RecordId } from '@factory/contract'
import type { UiReadySnapshot } from '@factory/domain'
import {
  initializeRepositoryStore,
  openRepositoryStore,
  withAdvisoryFileLock,
  type RepositoryStore,
} from '@factory/repository'
import { acceptReview, validateReview } from '@factory/review'
import { openVerifiedReviewBundle, readVerifiedReviewBundle } from '@factory/reviewer'
import { inspectRuntimeJournal } from '@factory/runtime-journal'
import type { LocalUiHandle } from '@factory/web'

import { sealReviewerRawAttempt } from '../../reviewer/src/attempt'
import { writerChoice, summarySubmissions } from '../../test-harness/src/choice-fixtures'
import { runFactoryCli } from '../src'
import { automaticReviewLockPath } from '../src/automatic-review'

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

async function installPullRequestFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<typeof fixture.env> {
  const gh = join(fixture.root, 'bin', 'gh')
  await writeFile(
    gh,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify({id:'R_base',nameWithOwner:'owner/repo',url:'https://github.com/owner/repo'}))
} else if (args[0] === 'pr' && args[1] === 'diff') {
  console.log('diff --git a/app.ts b/app.ts\\n+manual')
} else if (args[0] === 'api' && args.includes('graphql')) {
  console.log(JSON.stringify({data:{repository:{id:'R_base',nameWithOwner:'owner/repo',url:'https://github.com/owner/repo',pullRequest:{id:'PR_42',url:'https://github.com/owner/repo/pull/42',number:42,state:'OPEN',mergedAt:null,baseRefName:'main',baseRefOid:'1111111111111111111111111111111111111111',headRefName:'feature',headRefOid:head,updatedAt:'2026-09-05T00:00:00Z',headRepository:{id:'R_base',nameWithOwner:'owner/repo',url:'https://github.com/owner/repo'},commits:{nodes:[{commit:{oid:head}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}}))
} else process.exit(3)
`,
  )
  await chmod(gh, 0o755)
  return { ...fixture.env, PATH: `${join(fixture.root, 'bin')}:${fixture.env.PATH}` }
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

async function treeFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const visit = async (directory: string, relative = ''): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const item = await lstat(path)
      const key = relative === '' ? name : `${relative}/${name}`
      if (item.isDirectory()) await visit(path, key)
      else
        files.set(
          key,
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        )
    }
  }
  await visit(root)
  return files
}

async function importBundleRecords(repository: string, name: 'complete-bundle' | 'partial-bundle') {
  const source = join('/workspace/specs/done/factory-v1/assets/review-plan', name, '.factory')
  const destination = join(repository, '.factory')
  for (const entry of await readdir(source)) {
    await cp(join(source, entry), join(destination, entry), {
      recursive: true,
      force: false,
      errorOnExist: false,
    })
  }
}

async function acceptBundleReview(
  store: RepositoryStore,
  name: 'complete-bundle' | 'partial-bundle',
  reviewId: RecordId,
): Promise<void> {
  const root = '/workspace/specs/done/factory-v1/assets/review-plan'
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as {
    bundles: { complete: string; partial: string }
  }
  const bundle = await openVerifiedReviewBundle(
    join(root, name),
    name === 'complete-bundle' ? report.bundles.complete : report.bundles.partial,
  )
  const verified = await readVerifiedReviewBundle(bundle)
  const citation = verified.manifest.inventory[0]!
  const submissions =
    (name === 'complete-bundle'
      ? canonicalJson({
          kind: 'choice',
          choice: { ...writerChoice, evidence: [{ object: citation }] },
        })
      : '') + summarySubmissions([{ object: citation }])
  const validated = await validateReview(
    bundle,
    sealReviewerRawAttempt({
      providerOutput: new Uint8Array(),
      reviewId,
      bundleSha256: name === 'complete-bundle' ? report.bundles.complete : report.bundles.partial,
      submissions: new TextEncoder().encode(submissions),
      termination: 'completed',
      exitCode: 0,
      outputTruncated: false,
      reviewer: { settings: verified.manifest.plan.policies.reviewer },
      imageDigest: `sha256:${'b'.repeat(64)}`,
      providerCliVersion: 'test',
      hostPlatform: 'linux/arm64',
      startedAt: '2026-09-05T00:00:00Z',
      completedAt: name === 'complete-bundle' ? '2026-09-05T00:00:08Z' : '2026-09-05T00:00:09Z',
    }),
  )
  await acceptReview(validated, store)
}

describe('installed capture vertical', () => {
  test('records an explicit manual Session-to-PR association', async () => {
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
    await replay(value, 'codex')
    const [sessionKey] = await readdir(join(value.repository, '.factory', 'sessions', 'codex'))
    const environment = await installPullRequestFixture(value)
    const beforeRejectedAssociation = await treeDigest(join(value.repository, '.factory'))
    expect(
      (
        await command(
          value.factory,
          [
            'associate',
            '--pr',
            '9007199254740993',
            '--session',
            sessionKey!,
            '--actor',
            'david',
            '--reason',
            'Unsafe PR fixture.',
          ],
          value.repository,
          environment,
        )
      ).code,
    ).toBe(1)
    expect(await treeDigest(join(value.repository, '.factory'))).toBe(beforeRejectedAssociation)
    expect(
      (
        await command(
          value.factory,
          [
            'associate',
            '--pr',
            '42',
            '--session',
            'missing-session',
            '--actor',
            'david',
            '--reason',
            'Typo fixture.',
          ],
          value.repository,
          environment,
        )
      ).code,
    ).toBe(1)
    expect(await treeDigest(join(value.repository, '.factory'))).toBe(beforeRejectedAssociation)
    const result = await command(
      value.factory,
      [
        'associate',
        '--pr',
        '42',
        '--session',
        sessionKey!,
        '--actor',
        'david',
        '--reason',
        'This session contains the preparatory work.',
      ],
      value.repository,
      environment,
    )
    expect(result.code).toBe(0)

    let paths = await Array.fromAsync(
      new Bun.Glob('pull-requests/**/associations/**/*.json').scan({
        cwd: join(value.repository, '.factory'),
      }),
    )
    let records = await Promise.all(
      paths.map(async path =>
        JSON.parse(await readFile(join(value.repository, '.factory', path), 'utf8')),
      ),
    )
    expect(records.find(record => record.kind === 'manual')).toMatchObject({
      sessionKey,
      strength: 'asserted',
      assertion: { actor: 'david', reason: 'This session contains the preparatory work.' },
    })
    expect(
      records.find(record => record.kind === 'manual' && record.batchId !== undefined),
    ).toMatchObject({
      policyVersion: 'manual-v1',
    })

    const review = await command(
      value.factory,
      ['review', '--pr', '42'],
      value.repository,
      environment,
    )
    expect(review.code).toBe(1)
    expect(review.stderr).toBe('')
    expect(JSON.parse(review.stdout)).toMatchObject({
      disposition: 'failed',
      executionFailed: true,
    })
    paths = await Array.fromAsync(
      new Bun.Glob('pull-requests/**/associations/**/*.json').scan({
        cwd: join(value.repository, '.factory'),
      }),
    )
    records = await Promise.all(
      paths.map(async path =>
        JSON.parse(await readFile(join(value.repository, '.factory', path), 'utf8')),
      ),
    )
    const carried = records.filter(record => record.kind === 'manual' && record.evidenceId)
    expect(carried).toHaveLength(2)
    expect(new Set(carried.map(record => record.pullRequestObservationId)).size).toBe(2)
    expect(new Set(carried.map(record => record.observedAt)).size).toBe(1)
  })

  test('configures bounded reviewer resources with field-wise repository overrides', async () => {
    const fixture = await createFixture()
    await command(fixture.factory, ['init'], fixture.repository, fixture.env)
    const global = await command(
      fixture.factory,
      [
        'configure',
        '--global',
        '--docker-memory-mib',
        '3072',
        '--docker-cpus',
        '3',
        '--review-timeout-seconds',
        '90',
      ],
      fixture.repository,
      fixture.env,
    )
    expect(global.code).toBe(0)
    expect(JSON.parse(global.stdout.slice(global.stdout.indexOf('\n') + 1)).dockerLimits).toEqual({
      memoryMiB: 3072,
      cpus: 3,
      pids: 256,
      timeoutSeconds: 90,
    })
    const repo = await command(
      fixture.factory,
      ['configure', '--repo', '--docker-cpus', '1'],
      fixture.repository,
      fixture.env,
    )
    expect(repo.code).toBe(0)
    expect(JSON.parse(repo.stdout.slice(repo.stdout.indexOf('\n') + 1)).dockerLimits).toEqual({
      memoryMiB: 3072,
      cpus: 1,
      pids: 256,
      timeoutSeconds: 90,
    })
    const before = await readFile(join(fixture.repository, '.factory/config.json'), 'utf8')
    const invalid = await command(
      fixture.factory,
      ['configure', '--repo', '--docker-memory-mib', '0'],
      fixture.repository,
      fixture.env,
    )
    expect(invalid.code).toBe(1)
    expect(await readFile(join(fixture.repository, '.factory/config.json'), 'utf8')).toBe(before)
  })

  test('explicit update discovery caches advisory startup warnings and respects repository opt-out', async () => {
    const fixture = await createFixture()
    await command(fixture.factory, ['init'], fixture.repository, fixture.env)
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tag_name: 'v99.0.0', draft: false, prerelease: false })),
    )
    let stdout = '',
      stderr = ''
    try {
      const code = await runFactoryCli(['upgrade', '--check'], {
        cwd: fixture.repository,
        environment: fixture.env,
        output: {
          stdout: value => {
            stdout += value
          },
          stderr: value => {
            stderr += value
          },
        },
      })
      expect(code).toBe(0)
      expect(stdout).toContain('99.0.0')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        'https://api.github.com/repos/dzhng/factory/releases/latest',
      )
      const capture = await command(
        fixture.factory,
        ['capture', '--provider', 'codex'],
        fixture.repository,
        fixture.env,
        '{}',
      )
      expect(capture).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
      const automatic = await command(
        fixture.factory,
        ['review', '--automatic'],
        fixture.repository,
        fixture.env,
      )
      expect(automatic.stderr).toBe('')
      const cache = join(fixture.home, '.cache/factory/update-check.json')
      expect((await lstat(cache)).mode & 0o777).toBe(0o600)
      fetchSpy.mockRejectedValue(new Error('Startup must not fetch'))
      stdout = ''
      stderr = ''
      await runFactoryCli(['doctor'], {
        interactive: true,
        cwd: fixture.repository,
        environment: fixture.env,
        output: {
          stdout: value => {
            stdout += value
          },
          stderr: value => {
            stderr += value
          },
        },
      })
      expect(stderr).toContain('Factory 99.0.0 is available')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      await command(
        fixture.factory,
        ['configure', '--repo', '--update-checks', 'false'],
        fixture.repository,
        fixture.env,
      )
      stderr = ''
      await runFactoryCli(['doctor'], {
        interactive: true,
        cwd: fixture.repository,
        environment: fixture.env,
        output: {
          stdout: () => {},
          stderr: value => {
            stderr += value
          },
        },
      })
      expect(stderr).toBe('')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('update discovery refuses oversized release data without replacing a cached observation', async () => {
    const fixture = await createFixture()
    const cache = join(fixture.home, '.cache/factory/update-check.json')
    await mkdir(join(fixture.home, '.cache/factory'), { recursive: true })
    const previous = JSON.stringify({ schemaVersion: 1, checkedAt: Date.now(), version: '98.0.0' })
    await writeFile(cache, previous)
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(65537)))
    try {
      let stderr = ''
      const code = await runFactoryCli(['upgrade', '--check'], {
        cwd: fixture.repository,
        environment: fixture.env,
        output: {
          stdout: () => {},
          stderr: value => {
            stderr += value
          },
        },
      })
      expect(code).toBe(1)
      expect(stderr).toContain('exceeds size bound')
      expect(await readFile(cache, 'utf8')).toBe(previous)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('preserves unrelated global settings during a partial configure update', async () => {
    const value = await createFixture()
    expect(
      await command(
        value.factory,
        ['configure', '--global', '--canonical-branch', 'trunk', '--automatic-review', 'true'],
        value.repository,
        value.env,
      ),
    ).toMatchObject({ code: 0 })

    expect(
      await command(
        value.factory,
        [
          'configure',
          '--global',
          '--repository-initialization',
          'automatic',
          '--acknowledge-plaintext-evidence',
        ],
        value.repository,
        value.env,
      ),
    ).toMatchObject({ code: 0 })
    expect(
      JSON.parse(await readFile(join(value.home, '.config', 'factory', 'config.json'), 'utf8')),
    ).toEqual({
      automaticReview: true,
      canonicalBranch: 'trunk',
      repositoryInitialization: 'automatic',
    })
  })

  test('review execution honors global reviewer preferences and repository overrides', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    expect(
      (
        await command(
          value.factory,
          ['configure', '--global', '--reviewer', 'claude'],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)
    const globalReview = await command(value.factory, ['review'], value.repository, value.env)
    expect(JSON.parse(globalReview.stdout).reviewer.provider).toBe('claude')
    expect(
      (
        await command(
          value.factory,
          ['configure', '--repo', '--reviewer', 'codex'],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)
    const repoReview = await command(value.factory, ['review'], value.repository, value.env)
    expect(JSON.parse(repoReview.stdout).reviewer.provider).toBe('codex')
  })

  test('configured deadline records a timeout while Docker is acquiring the reviewer image', async () => {
    const fixture = await createFixture()
    await command(fixture.factory, ['init'], fixture.repository, fixture.env)
    const docker = join(fixture.root, 'bin', 'docker')
    await writeFile(
      docker,
      '#!/bin/sh\ncase "$1" in\nversion) echo 27.5.1;;\npull) exec sleep 10;;\n*) exit 1;;\nesac\n',
    )
    await chmod(docker, 0o755)
    const auth = join(fixture.root, 'auth.json')
    await writeFile(auth, 'fake-provider-credential', { mode: 0o444 })
    // The product refuses root-owned credentials. Only this disposable fixture
    // changes owner when the outer Docker test runner itself runs as root.
    const rootRunner = process.getuid?.() === 0
    if (rootRunner)
      expect(
        (await command('chown', ['-R', '1000:1000', fixture.root], fixture.repository, fixture.env))
          .code,
      ).toBe(0)
    const review = await command(
      rootRunner ? 'setpriv' : fixture.factory,
      [
        ...(rootRunner ? ['--reuid=1000', '--regid=1000', '--clear-groups', fixture.factory] : []),
        'review',
        '--review-timeout-seconds',
        '1',
      ],
      fixture.repository,
      {
        ...fixture.env,
        FACTORY_CODEX_AUTH_FILE: auth,
        FACTORY_CLAUDE_AUTH_FILE: join(fixture.root, 'missing-auth'),
      },
    )
    expect(review.code).toBe(1)
    const result = JSON.parse(review.stdout) as { paths: { manifest: string } }
    const manifest = JSON.parse(
      await readFile(join(fixture.repository, '.factory', result.paths.manifest), 'utf8'),
    )
    expect(manifest.failureReason).toBe('reviewer-timeout')
  })

  test('open refresh observes canonical drift without changing repository configuration', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const gh = join(value.root, 'bin', 'gh')
    const branch = join(value.root, 'bin', 'default-branch')
    await writeFile(gh, '#!/bin/sh\ncat "${0%/*}/default-branch"\n')
    await chmod(gh, 0o755)
    await writeFile(branch, 'trunk\n')
    const controller = new AbortController()
    let started!: (handle: LocalUiHandle) => void
    const ready = new Promise<LocalUiHandle>(resolve => {
      started = resolve
    })
    const running = runFactoryCli(['open'], {
      cwd: value.repository,
      environment: value.env,
      output: { stdout: () => undefined, stderr: () => undefined },
      open: { signal: controller.signal, launchBrowser: async () => undefined, onStarted: started },
    })
    const handle = await ready
    try {
      const snapshot = async () =>
        (await fetch(`${handle.origin}/api/snapshot`).then(response =>
          response.json(),
        )) as UiReadySnapshot
      expect((await snapshot()).diagnostics).toContainEqual({
        priority: 'high',
        message: 'Canonical branch main differs from GitHub default trunk',
      })
      await writeFile(branch, 'main\n')
      expect((await snapshot()).diagnostics).not.toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('differs from GitHub'),
        }),
      )
      await writeFile(gh, '#!/bin/sh\nexit 1\n')
      expect((await snapshot()).diagnostics).not.toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('differs from GitHub'),
        }),
      )
      await expect(
        (await openRepositoryStore(value.repository))
          .readConfig()
          .then(config => config.canonicalBranch),
      ).resolves.toBe('main')
      await writeFile(gh, '#!/bin/sh\nsleep 10\n')
      const slow = await fetch(`${handle.origin}/api/snapshot`, {
        signal: AbortSignal.timeout(2_000),
      })
      expect(slow.status).toBe(200)
      await writeFile(gh, '#!/bin/sh\ntouch "${0%/*}/called"\nexit 1\n')
      const session = (await fetch(`${handle.origin}/api/session`).then(response =>
        response.json(),
      )) as { csrfToken: string }
      await fetch(`${handle.origin}/api/actions/coverage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: handle.origin,
          'X-Factory-CSRF': session.csrfToken,
        },
        body: JSON.stringify({ reviewId: 'review_00000000000000000000000001' }),
      })
      expect(await pathExists(join(value.root, 'bin', 'called'))).toBe(false)
    } finally {
      controller.abort()
      expect(await running).toBe(0)
    }
  })

  test.each(['script', 'native'])('automatic review drains durable triggers (%s)', async kind => {
    const value = await createFixture()
    if (kind === 'native') {
      value.factory = join(value.root, 'native-factory')
      expect(
        (
          await command(
            'bun',
            [
              'build',
              '/workspace/packages/cli/src/main.ts',
              '--compile',
              '--outfile',
              value.factory,
            ],
            value.root,
            value.env,
          )
        ).code,
      ).toBe(0)
    }
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const transcript = join(value.home, '.codex', 'sessions', 'automatic-review.jsonl')
    await writeFile(transcript, '{"type":"message"}\n')
    const captureEvent = (hook_event_name: string) =>
      command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        JSON.stringify({
          session_id: 'automatic-review',
          hook_event_name,
          cwd: value.repository,
          ...(hook_event_name === 'Stop' ? { turn_id: 'stop-1', transcript_path: transcript } : {}),
        }) + '\n',
      )
    const manifests = async () =>
      await Array.fromAsync(
        new Bun.Glob('reviews/**/manifest.json').scan({ cwd: join(value.repository, '.factory') }),
      )
    expect(await captureEvent('SessionStart')).toMatchObject({ code: 0, stdout: '{}\n' })
    expect(await captureEvent('Stop')).toMatchObject({ code: 0, stdout: '{}\n' })
    expect(await manifests()).toEqual([])
    expect(
      (
        await command(
          value.factory,
          ['configure', '--global', '--automatic-review', 'true'],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)
    expect(
      (
        await command(
          value.factory,
          ['configure', '--repo', '--automatic-review', 'false'],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)
    expect(await captureEvent('SessionStart')).toMatchObject({ code: 0, stdout: '{}\n' })
    expect(
      (await command(value.factory, ['review', '--automatic'], value.repository, value.env)).code,
    ).toBe(0)
    expect(await manifests()).toEqual([])
    expect(
      (
        await command(
          value.factory,
          ['configure', '--repo', '--automatic-review', 'true'],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(0)
    await withAdvisoryFileLock(await automaticReviewLockPath(value.repository), 0, async () => {
      expect(await captureEvent('SessionStart')).toMatchObject({ code: 0, stdout: '{}\n' })
      expect(
        (await command(value.factory, ['review', '--automatic'], value.repository, value.env)).code,
      ).toBe(0)
      expect(await manifests()).toEqual([])
      await cp(join(value.repository, '.factory'), join(value.root, 'captured-factory'), {
        recursive: true,
      })
    })
    expect(await captureEvent('SessionStart')).toMatchObject({ code: 0, stdout: '{}\n' })
    const deadline = Date.now() + 3_000
    while ((await manifests()).length === 0 && Date.now() < deadline) await Bun.sleep(20)
    const paths = await manifests()
    expect(paths).toHaveLength(1)
    const review = JSON.parse(await readFile(join(value.repository, '.factory', paths[0]!), 'utf8'))
    expect(review).toMatchObject({
      disposition: 'failed',
      failureReason: 'authentication-unavailable',
    })
    const triggers = await Array.fromAsync(
      new Bun.Glob('review-triggers/*.json').scan({ cwd: join(value.repository, '.factory') }),
    )
    expect(review.triggerIds).toEqual(
      triggers.map(path => path.slice('review-triggers/'.length, -'.json'.length)),
    )
    expect(await captureEvent('Stop')).toMatchObject({ code: 0, stdout: '{}\n' })
    expect(
      (await command(value.factory, ['review', '--automatic'], value.repository, value.env)).code,
    ).toBe(0)
    expect(await manifests()).toEqual(paths)
    let inspection = await inspectRuntimeJournal(value.repository)
    const diagnosticDeadline = Date.now() + 1_000
    while (
      inspection.state === 'available' &&
      inspection.diagnostics.length === 0 &&
      Date.now() < diagnosticDeadline
    ) {
      await Bun.sleep(20)
      inspection = await inspectRuntimeJournal(value.repository)
    }
    if (inspection.state !== 'available') throw new Error('runtime diagnostics unavailable')
    const diagnostics = await Promise.all(
      inspection.diagnostics.map(name =>
        readFile(
          join(value.repository, '.git', 'factory-runtime', 'journal-v1', 'diagnostics', name),
          'utf8',
        ),
      ),
    )
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Error: automatic review failed; run factory review for details'),
      ]),
    )
    await withAdvisoryFileLock(await automaticReviewLockPath(value.repository), 1_000, async () => {
      const linked = join(value.root, 'linked')
      await git(value.repository, 'worktree', 'add', '-b', 'linked', linked)
      await cp(join(value.root, 'captured-factory'), join(linked, '.factory'), { recursive: true })
      expect(
        (await command(value.factory, ['review', '--automatic'], linked, value.env)).code,
      ).toBe(1)
      const linkedReviews = await Array.fromAsync(
        new Bun.Glob('reviews/**/manifest.json').scan({ cwd: join(linked, '.factory') }),
      )
      expect(linkedReviews).toHaveLength(1)
      expect(
        JSON.parse(await readFile(join(linked, '.factory', linkedReviews[0]!), 'utf8')),
      ).toMatchObject({ failureReason: 'authentication-unavailable' })
      expect(
        (await command(value.factory, ['review', '--automatic'], linked, value.env)).code,
      ).toBe(0)
      expect(
        await Array.fromAsync(
          new Bun.Glob('reviews/**/manifest.json').scan({ cwd: join(linked, '.factory') }),
        ),
      ).toEqual(linkedReviews)
    })
  })

  test('configures from GitHub while preserving explicit override and source-aware drift', async () => {
    const value = await createFixture()
    const gh = join(value.root, 'bin', 'gh')
    await writeFile(gh, '#!/bin/sh\n[ "$1 $2" = "repo view" ] || exit 2\nprintf "trunk\\n"\n')
    await chmod(gh, 0o755)
    await initializeRepositoryStore(
      value.repository,
      {
        schemaVersion: 1,
        format: 'factory-repository',
        minimumReaderVersion: '0.1.0',
        repositoryId: 'repo_default_branch',
        createdAt: '2026-09-05T00:00:00Z',
      },
      {},
    )

    expect(
      await command(value.factory, ['configure', '--repo'], value.repository, value.env),
    ).toMatchObject({
      code: 0,
    })
    expect((await openRepositoryStore(value.repository)).readConfig()).resolves.toMatchObject({
      canonicalBranch: 'trunk',
    })

    expect(
      await command(
        value.factory,
        ['configure', '--repo', '--canonical-branch', 'release', '--reviewer', 'claude'],
        value.repository,
        value.env,
      ),
    ).toMatchObject({ code: 0 })
    expect((await openRepositoryStore(value.repository)).readConfig()).resolves.toMatchObject({
      canonicalBranch: 'release',
      reviewer: { provider: 'claude' },
    })
    expect(
      await command(
        value.factory,
        ['configure', '--repo', '--reviewer', 'unknown'],
        value.repository,
        value.env,
      ),
    ).toMatchObject({ code: 1, stderr: expect.stringContaining('auto, codex, or claude') })
    expect(
      await command(
        value.factory,
        ['configure', '--repo', '--canonical-branch', 'HEAD'],
        value.repository,
        value.env,
      ),
    ).toMatchObject({ code: 1, stderr: expect.stringContaining('valid Git branch name') })
    const githubDoctor = await command(value.factory, ['doctor'], value.repository, value.env)
    expect(githubDoctor).toMatchObject({ code: 0, stderr: '' })
    const githubDrift = JSON.parse(githubDoctor.stdout)
    expect(githubDrift).toMatchObject({
      canonicalBranch: 'release',
      observedDefaultBranch: 'trunk',
      canonicalBranchDrift: true,
      github: { availability: 'available', branch: 'trunk' },
    })
    expect(githubDrift.diagnostics).toContainEqual({
      code: 'canonical-branch-drift',
      severity: 'high',
      summary: 'Canonical branch release differs from GitHub default trunk',
    })

    await unlink(gh)
    const localFallback = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(localFallback).toMatchObject({
      canonicalBranch: 'release',
      observedDefaultBranch: 'main',
      canonicalBranchDrift: false,
      github: { availability: 'unavailable', reason: 'gh-missing' },
    })
    expect(
      localFallback.diagnostics.some(
        (diagnostic: { code: string }) => diagnostic.code === 'canonical-branch-drift',
      ),
    ).toBeFalse()
  })

  test('serves factory open only for the foreground CLI lifetime', async () => {
    const value = await createFixture()
    expect(await command(value.factory, ['init'], value.repository, value.env)).toMatchObject({
      code: 0,
    })
    const controller = new AbortController()
    let started!: (handle: LocalUiHandle) => void
    const ready = new Promise<LocalUiHandle>(resolve => {
      started = resolve
    })
    let launched = ''
    let stdout = ''
    const running = runFactoryCli(['open'], {
      cwd: value.repository,
      environment: value.env,
      output: {
        stdout: text => {
          stdout += text
        },
        stderr: () => undefined,
      },
      open: {
        signal: controller.signal,
        launchBrowser: async url => {
          launched = url
        },
        onStarted: started,
      },
    })
    const handle = await ready
    expect(handle.hostname).toBe('127.0.0.1')
    expect(launched).toBe(handle.origin)
    const snapshot = await fetch(`${handle.origin}/api/snapshot`)
    expect(snapshot.status).toBe(200)
    expect(await snapshot.json()).toMatchObject({ state: 'ready', canonicalBranch: 'main' })
    expect(stdout).toBe(`${handle.origin}\n`)

    controller.abort()
    expect(await running).toBe(0)
    await expect(fetch(handle.origin)).rejects.toThrow()
  })

  test('honors a signal that was aborted before factory open starts', async () => {
    const value = await createFixture()
    expect(await command(value.factory, ['init'], value.repository, value.env)).toMatchObject({
      code: 0,
    })
    const controller = new AbortController()
    controller.abort()
    let handle: LocalUiHandle | undefined
    const code = await runFactoryCli(['open'], {
      cwd: value.repository,
      environment: value.env,
      output: { stdout: () => undefined, stderr: () => undefined },
      open: {
        signal: controller.signal,
        launchBrowser: async () => undefined,
        onStarted: value => {
          handle = value
        },
      },
    })
    expect(code).toBe(0)
    expect(handle).toBeDefined()
    await expect(fetch(handle!.origin)).rejects.toThrow()
  })

  test('routes browser actions through the real repository append-only seams', async () => {
    const value = await createFixture()
    const store = await initializeRepositoryStore(
      value.repository,
      {
        schemaVersion: 1,
        format: 'factory-repository',
        minimumReaderVersion: '0.1.0',
        repositoryId: 'repo_review_lab',
        createdAt: '2026-09-05T00:00:00Z',
      },
      { canonicalBranch: 'feature/review' },
    )
    await importBundleRecords(value.repository, 'complete-bundle')
    await importBundleRecords(value.repository, 'partial-bundle')
    const completeReviewId = 'review_00000000000000000000000018' as RecordId
    const partialReviewId = 'review_00000000000000000000000019' as RecordId
    await acceptBundleReview(store, 'complete-bundle', completeReviewId)
    await acceptBundleReview(store, 'partial-bundle', partialReviewId)

    const before = await treeFiles(join(value.repository, '.factory'))
    const controller = new AbortController()
    let started!: (handle: LocalUiHandle) => void
    const ready = new Promise<LocalUiHandle>(resolve => {
      started = resolve
    })
    const running = runFactoryCli(['open'], {
      cwd: value.repository,
      environment: value.env,
      output: { stdout: () => undefined, stderr: () => undefined },
      open: {
        signal: controller.signal,
        launchBrowser: async () => undefined,
        onStarted: started,
      },
    })
    const handle = await ready
    const [snapshot, session] = (await Promise.all([
      fetch(`${handle.origin}/api/snapshot`).then(response => response.json()),
      fetch(`${handle.origin}/api/session`).then(response => response.json()),
    ])) as [
      {
        decisions: {
          stateFingerprint: string
          lineages: {
            observations: { humanStatus: string; observation: { observationId: string } }[]
          }[]
        }
      },
      { csrfToken: string },
    ]
    expect(snapshot).toMatchObject({
      state: 'ready',
      canonicalBranch: 'feature/review',
      counts: { reviews: 2 },
    })
    const decision = snapshot.decisions.lineages[0]!.observations.find(
      (item: { humanStatus: string }) => item.humanStatus === 'unconfirmed',
    )
    expect(decision).toBeDefined()
    const headers = {
      'Content-Type': 'application/json',
      Origin: handle.origin,
      'X-Factory-CSRF': session.csrfToken,
    }
    const decisionResponse = await fetch(`${handle.origin}/api/actions/decision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        actionId: 'action_00000000000000000000000021',
        kind: 'confirm',
        targetObservationId: decision!.observation.observationId,
        expectedStateFingerprint: snapshot.decisions.stateFingerprint,
      }),
    })
    expect(decisionResponse.status).toBe(201)
    const coverageResponse = await fetch(`${handle.origin}/api/actions/coverage`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reviewId: partialReviewId }),
    })
    expect(coverageResponse.status).toBe(201)
    controller.abort()
    expect(await running).toBe(0)

    const after = await treeFiles(join(value.repository, '.factory'))
    for (const [path, digest] of before) expect(after.get(path)).toBe(digest)
    const added = [...after.keys()].filter(path => !before.has(path)).sort()
    expect(added).toHaveLength(2)
    expect(added).toContain('decisions/actions/action_00000000000000000000000021.json')
    expect(added.some(path => /^reviews\/coverage-actions\/action_[^/]+\.json$/.test(path))).toBe(
      true,
    )
  })

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
    expect(report.repositoryStorageBytes).toBeGreaterThan(0)
    expect(report.runtimeStorageBytes).toBeGreaterThan(0)
    expect(report.installation).toMatchObject({
      ownership: 'available',
      executable: { path: value.factory, state: 'ready' },
      transaction: 'absent',
      providers: {
        codex: { config: 'available' },
        claude: { config: 'available' },
      },
    })
    expect(report.reviewer).toMatchObject({
      docker: { availability: 'unavailable', reason: 'missing' },
      credentials: {
        codex: { state: 'unconfigured' },
        claude: { state: 'unconfigured' },
      },
    })
    for (const provider of ['codex', 'claude']) {
      expect(
        report.installation.providers[provider].hooks.events.every(
          (event: { state: string }) => event.state === 'installed',
        ),
      ).toBeTrue()
    }
    expect(
      report.projection.sessions.map((session: { provider: string }) => session.provider),
    ).toEqual(['claude', 'codex'])
    expect(report.projection.triggers).toBe(2)
    expect(report.projection.issues).toEqual([])
    const openController = new AbortController()
    let openStarted!: (handle: LocalUiHandle) => void
    const openReady = new Promise<LocalUiHandle>(resolve => {
      openStarted = resolve
    })
    const open = runFactoryCli(['open'], {
      cwd: value.repository,
      environment: value.env,
      output: { stdout: () => undefined, stderr: () => undefined },
      open: {
        signal: openController.signal,
        launchBrowser: async () => undefined,
        onStarted: openStarted,
      },
    })
    const openHandle = await openReady
    const openSnapshot = await fetch(`${openHandle.origin}/api/snapshot`).then(response =>
      response.json(),
    )
    expect(openSnapshot).toMatchObject({
      state: 'ready',
      counts: { sessions: 2, turns: 2, pendingTriggers: 2 },
    })
    openController.abort()
    expect(await open).toBe(0)
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
      if (evidenceReport.installation !== undefined) {
        evidenceReport.installation.executable.path = '<packaged-fixture>'
        for (const provider of ['codex', 'claude']) {
          evidenceReport.installation.providers[provider].path =
            provider === 'codex' ? '$CODEX_HOME/hooks.json' : '$CLAUDE_CONFIG_DIR/settings.json'
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
    const afterUninstall = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(afterUninstall.installation.ownership).toBe('absent')
    await expect(
      lstat(join(value.home, '.config', 'factory', 'hooks-state.json')),
    ).rejects.toThrow()
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
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
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
    const diagnosed = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(
      diagnosed.installation.providers.codex.hooks.events.find(
        (event: { event: string }) => event.event === 'Stop',
      ),
    ).toMatchObject({ state: 'missing', exactOwnedMatches: 0, factoryLikeUnownedMatches: 1 })
    expect((await command(value.factory, ['uninstall'], value.repository, value.env)).code).toBe(0)
    const afterUninstall = JSON.parse(await readFile(codexPath, 'utf8'))
    expect(afterUninstall.hooks.Stop).toContainEqual(edited.hooks.Stop.at(-1))
  })

  test('bounds provider configuration reads in install and diagnostics', async () => {
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
    const codexPath = join(value.home, '.codex', 'hooks.json')
    await writeFile(codexPath, ' '.repeat(4 * 1024 * 1024 + 1), { mode: 0o600 })

    const report = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(report.installation.providers.codex).toMatchObject({
      config: 'invalid',
      error: expect.stringContaining('size bound'),
    })
    expect(
      await command(
        value.factory,
        ['install', '--executable', value.factory],
        value.repository,
        value.env,
      ),
    ).toMatchObject({ code: 1, stderr: expect.stringContaining('size bound') })
    expect((await lstat(codexPath)).size).toBe(4 * 1024 * 1024 + 1)
  })

  test('refuses malformed or unsafe installation transactions before mutation', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const transaction = join(value.home, '.config', 'factory', 'installation-transaction.json')
    await mkdir(join(value.home, '.config', 'factory'), { recursive: true })
    const validShape = {
      schemaVersion: 1,
      kind: 'hook-reconciliation',
      provider: 'codex',
      path: join(value.home, '.codex', 'hooks.json'),
      beforeSha256: '0'.repeat(64),
      afterSha256: '1'.repeat(64),
      bytes: '',
      nextState: {
        schemaVersion: 1,
        executable: value.factory,
        providers: {},
      },
    }
    for (const malformed of [
      { ...validShape, kind: 'unknown-operation' },
      { ...validShape, kind: undefined },
      { ...validShape, schemaVersion: 2 },
      { ...validShape, provider: 'other' },
      { ...validShape, nextState: { ...validShape.nextState, executable: 'relative' } },
    ]) {
      await writeFile(transaction, `${JSON.stringify(malformed)}\n`, { mode: 0o600 })
      const diagnosis = JSON.parse(
        (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
      )
      expect(diagnosis.installation).toMatchObject({
        transaction: 'invalid',
        transactionError: expect.stringContaining('transaction is invalid'),
      })
      expect(
        await command(
          value.factory,
          ['install', '--executable', value.factory],
          value.repository,
          value.env,
        ),
      ).toMatchObject({ code: 1, stderr: expect.stringContaining('transaction is invalid') })
      expect(await Bun.file(transaction).exists()).toBeTrue()
    }

    await unlink(transaction)
    await symlink(value.home, transaction)
    const report = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(report.installation).toMatchObject({
      transaction: 'invalid',
      transactionError: 'installation transaction is unsafe',
    })
  })

  test('diagnoses transaction bytes, ownership, and provider divergence before recovery', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    expect(
      (
        await command(value.factory, ['install', '--executable', value.factory], value.repository, {
          ...value.env,
          FACTORY_TEST_HOOK_CRASH: 'after-journal',
        })
      ).code,
    ).toBe(1)
    const transactionPath = join(value.home, '.config', 'factory', 'installation-transaction.json')
    const providerPath = join(value.home, '.codex', 'hooks.json')
    const valid = JSON.parse(await readFile(transactionPath, 'utf8'))
    const originalProvider = (await Bun.file(providerPath).exists())
      ? await readFile(providerPath)
      : Buffer.from('{}\n')
    const cases = [
      {
        transaction: { ...valid, bytes: Buffer.from('{}\n').toString('base64') },
        error: 'bytes are corrupt',
      },
      {
        transaction: {
          ...valid,
          nextState: {
            ...valid.nextState,
            providers: {
              ...valid.nextState.providers,
              codex: {
                ...valid.nextState.providers.codex,
                fingerprints: valid.nextState.providers.codex.fingerprints.map(
                  (entry: { event: string; fingerprint: string }, index: number) =>
                    index === 0 ? { ...entry, fingerprint: '0'.repeat(64) } : entry,
                ),
              },
            },
          },
        },
        error: 'ownership does not match provider hooks',
      },
    ]
    for (const scenario of cases) {
      await writeFile(transactionPath, `${JSON.stringify(scenario.transaction)}\n`, { mode: 0o600 })
      await writeFile(providerPath, originalProvider, { mode: 0o600 })
      const report = JSON.parse(
        (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
      )
      expect(report.installation).toMatchObject({
        transaction: 'invalid',
        transactionError: expect.stringContaining(scenario.error),
      })
      expect(
        await command(
          value.factory,
          ['install', '--executable', value.factory],
          value.repository,
          value.env,
        ),
      ).toMatchObject({ code: 1, stderr: expect.stringContaining(scenario.error) })
    }

    await writeFile(transactionPath, `${JSON.stringify(valid)}\n`, { mode: 0o600 })
    await writeFile(providerPath, '{"owner":"edited-concurrently","hooks":{}}\n', { mode: 0o600 })
    const report = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(report.installation).toMatchObject({
      transaction: 'invalid',
      transactionError: expect.stringContaining('provider hooks changed'),
    })
    expect(
      await command(
        value.factory,
        ['install', '--executable', value.factory],
        value.repository,
        value.env,
      ),
    ).toMatchObject({ code: 1, stderr: expect.stringContaining('provider hooks changed') })
    expect(JSON.parse(await readFile(providerPath, 'utf8')).owner).toBe('edited-concurrently')
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

  test('preserves a provider edit discovered during interrupted reconciliation', async () => {
    const value = await createFixture()
    const codexPath = join(value.home, '.codex', 'hooks.json')
    await writeFile(codexPath, '{"hooks":{},"owner":"user"}\n')
    expect(
      (
        await command(value.factory, ['install', '--executable', value.factory], value.repository, {
          ...value.env,
          FACTORY_TEST_HOOK_CRASH: 'after-journal',
        })
      ).code,
    ).toBe(1)
    await writeFile(codexPath, '{"hooks":{},"owner":"edited-concurrently"}\n')
    expect(
      (
        await command(
          value.factory,
          ['install', '--executable', value.factory],
          value.repository,
          value.env,
        )
      ).code,
    ).toBe(1)
    expect(JSON.parse(await readFile(codexPath, 'utf8')).owner).toBe('edited-concurrently')
  })

  test('observes a linked worktree without calling it a cross-repository Session', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    await git(value.repository, 'add', '.factory/manifest.json', '.factory/config.json')
    await git(value.repository, 'commit', '-m', 'initialize Factory')
    const linked = join(value.root, 'linked')
    await git(value.repository, 'worktree', 'add', '-b', 'linked-feature', linked)
    const transcript = join(value.home, '.codex', 'sessions', 'linked.jsonl')
    await writeFile(transcript, '{"type":"message"}\n')
    const send = async (repository: string, payload: Record<string, unknown>) => {
      expect(
        await command(
          value.factory,
          ['capture', '--provider', 'codex'],
          repository,
          value.env,
          `${JSON.stringify({ session_id: 'linked-session', cwd: repository, ...payload })}\n`,
        ),
      ).toMatchObject({ code: 0, stdout: '{}\n' })
    }
    await send(value.repository, { hook_event_name: 'Stop', turn_id: 'primary-stop' })
    await send(linked, {
      hook_event_name: 'Stop',
      turn_id: 'linked-stop',
      transcript_path: transcript,
    })
    const ownerReport = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    const linkedReport = JSON.parse(
      (await command(value.factory, ['doctor'], linked, value.env)).stdout,
    )
    expect(ownerReport.projection.sessions[0].turns).toBe(1)
    expect(linkedReport.projection.sessions[0].turns).toBe(1)
    const turnRoot = join(
      linked,
      '.factory',
      'sessions',
      'codex',
      linkedReport.projection.sessions[0].sessionKey,
      'turns',
    )
    const manifests = await Promise.all(
      (await readdir(turnRoot)).map(id =>
        readFile(join(turnRoot, id, 'manifest.json'), 'utf8').then(JSON.parse),
      ),
    )
    const linkedManifest = manifests.find(manifest => manifest.branch === 'linked-feature')
    expect(linkedManifest).toBeDefined()
    expect(
      linkedManifest.limitations.some(
        (limitation: { code: string }) => limitation.code === 'cross-repository-session',
      ),
    ).toBeFalse()
  })

  test('recovers linked-worktree SessionEnd into its exact portable destination', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    await git(value.repository, 'add', '.factory/manifest.json', '.factory/config.json')
    await git(value.repository, 'commit', '-m', 'initialize Factory')
    const linked = join(value.root, 'linked-lifecycle')
    await git(value.repository, 'worktree', 'add', '-b', 'linked-lifecycle', linked)
    const send = async (payload: Record<string, unknown>) =>
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        linked,
        value.env,
        `${JSON.stringify({ session_id: 'linked-lifecycle', cwd: linked, ...payload })}\n`,
      )
    expect(await send({ hook_event_name: 'Stop', turn_id: 'linked-stop' })).toMatchObject({
      code: 0,
      stdout: '{}\n',
    })
    expect(await send({ hook_event_name: 'SessionEnd' })).toMatchObject({
      code: 0,
      stdout: '{}\n',
    })
    const linkedReport = JSON.parse(
      (await command(value.factory, ['doctor'], linked, value.env)).stdout,
    )
    const lifecycleRoot = join(
      linked,
      '.factory',
      'sessions',
      'codex',
      linkedReport.projection.sessions[0].sessionKey,
      'lifecycle',
    )
    for (const name of await readdir(lifecycleRoot)) await unlink(join(lifecycleRoot, name))
    const common = await git(
      value.repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    )
    const database = new Database(join(common, 'factory-runtime', 'journal-v1', 'journal.sqlite'))
    database.run('DELETE FROM lifecycle_completions')
    database.close(false)

    const repaired = JSON.parse(
      (await command(value.factory, ['doctor', '--repair'], value.repository, value.env)).stdout,
    )
    expect(repaired.pendingLifecycle).toBe(0)
    expect((await readdir(lifecycleRoot)).length).toBe(1)
  })

  test('keeps a linked-worktree Stop pending when that branch predates Factory init', async () => {
    const value = await createFixture()
    await git(value.repository, 'branch', 'before-factory')
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const linked = join(value.root, 'linked-before-factory')
    await git(value.repository, 'worktree', 'add', linked, 'before-factory')
    const send = async (repository: string, turn: string) =>
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        repository,
        value.env,
        `${JSON.stringify({ session_id: 'predates-init', hook_event_name: 'Stop', turn_id: turn, cwd: repository })}\n`,
      )
    expect(await send(value.repository, 'owner-stop')).toMatchObject({ code: 0, stdout: '{}\n' })
    expect(await send(linked, 'linked-stop')).toMatchObject({ code: 0, stdout: '{}\n' })
    const report = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(report.pendingStops).toBe(1)
    expect(report.captureDiagnostics.length).toBeGreaterThan(0)
    expect(await send(linked, 'linked-stop')).toMatchObject({ code: 0, stdout: '{}\n' })
    const repeated = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(repeated.captureDiagnostics).toEqual(report.captureDiagnostics)
    expect(await pathExists(join(linked, '.factory'))).toBeFalse()
  })

  test('bounds the doctor diagnostic inventory', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        `${JSON.stringify({ session_id: 'diagnostic-bound', hook_event_name: 'Stop', turn_id: 'stop-1', cwd: value.repository })}\n`,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const common = await git(
      value.repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    )
    const diagnostics = join(common, 'factory-runtime', 'journal-v1', 'diagnostics')
    for (let first = 0; first < 10_001; first += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, 10_001 - first) }, async (_unused, offset) => {
          const name = createHash('sha256')
            .update(`diagnostic-${first + offset}`)
            .digest('hex')
          await writeFile(join(diagnostics, `${name}.txt`), 'diagnostic\n', { mode: 0o600 })
        }),
      )
    }
    const report = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(report.captureDiagnostics).toHaveLength(10_001)
    expect(report.captureDiagnostics.at(-1)).toBe('inventory-exceeds-bound')
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

  test('does not retire recovery when a committed Turn graph loses a dependency', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const payload = {
      session_id: 'damaged-graph',
      turn_id: 'damaged-stop',
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
    const initial = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    const sessionKey = initial.projection.sessions[0].sessionKey
    const turnsRoot = join(value.repository, '.factory', 'sessions', 'codex', sessionKey, 'turns')
    const turnId = (await readdir(turnsRoot))[0]!
    await unlink(join(turnsRoot, turnId, 'events.jsonl'))
    const common = await git(
      value.repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    )
    const database = new Database(join(common, 'factory-runtime', 'journal-v1', 'journal.sqlite'))
    database.run('DELETE FROM completions')
    database.close(false)

    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        `${JSON.stringify({ session_id: 'damaged-graph', hook_event_name: 'SessionEnd', cwd: value.repository })}\n`,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const damaged = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(damaged.pendingStops).toBe(1)
    expect(damaged.projection.triggers).toBe(0)
    expect(damaged.captureDiagnostics.length).toBeGreaterThan(0)
  })

  test('verifies a patch dependency when the observation has no code manifest', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const payload = {
      session_id: 'missing-first-patch',
      turn_id: 'missing-first-patch-stop',
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
    const initial = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    const sessionKey = initial.projection.sessions[0].sessionKey
    const turnsRoot = join(value.repository, '.factory', 'sessions', 'codex', sessionKey, 'turns')
    const turnId = (await readdir(turnsRoot))[0]!
    const manifestPath = join(turnsRoot, turnId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const observationPath = join(
      value.repository,
      '.factory',
      'repository-observations',
      `${manifest.repositoryObservationId}.json`,
    )
    const observation = JSON.parse(await readFile(observationPath, 'utf8'))
    const missingPatch = {
      algorithm: 'sha256',
      sha256: 'f'.repeat(64),
      bytes: 1,
      mediaType: 'text/x-diff',
      role: 'staged-patch',
    }
    delete observation.codeManifest
    observation.stagedPatch = missingPatch
    delete manifest.codeManifest
    manifest.stagedPatch = missingPatch
    manifest.inventory = [
      ...manifest.rawObjects,
      ...manifest.transcriptObservations,
      missingPatch,
    ].sort((left, right) => left.sha256.localeCompare(right.sha256))
    await Promise.all([
      writeFile(observationPath, canonicalJson(observation)),
      writeFile(manifestPath, canonicalJson(manifest)),
    ])
    const common = await git(
      value.repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    )
    const database = new Database(join(common, 'factory-runtime', 'journal-v1', 'journal.sqlite'))
    database.run('DELETE FROM completions')
    database.close(false)

    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        `${JSON.stringify({ session_id: 'missing-first-patch', hook_event_name: 'SessionEnd', cwd: value.repository })}\n`,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const damaged = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(damaged.pendingStops).toBe(1)
    expect(damaged.captureDiagnostics.length).toBeGreaterThan(0)
  })

  test('rejects schema-valid Turn and trigger rewrites during completion recovery', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    const stop = `${JSON.stringify({ session_id: 'rewritten-graph', hook_event_name: 'Stop', turn_id: 'rewritten-stop', cwd: value.repository })}\n`
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        stop,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const initial = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    const sessionKey = initial.projection.sessions[0].sessionKey
    const turnsRoot = join(value.repository, '.factory', 'sessions', 'codex', sessionKey, 'turns')
    const turnId = (await readdir(turnsRoot))[0]!
    const manifestPath = join(turnsRoot, turnId, 'manifest.json')
    const originalManifest = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(originalManifest)
    const observationPath = join(
      value.repository,
      '.factory',
      'repository-observations',
      `${manifest.repositoryObservationId}.json`,
    )
    const originalObservation = await readFile(observationPath, 'utf8')
    const observation = JSON.parse(originalObservation)
    const originalCodeManifest = observation.codeManifest
    const mislabelledCodeManifest = { ...originalCodeManifest, role: 'workspace-file' }
    observation.codeManifest = mislabelledCodeManifest
    manifest.codeManifest = mislabelledCodeManifest
    manifest.inventory = manifest.inventory.map((reference: { sha256: string; role: string }) =>
      reference.sha256 === originalCodeManifest.sha256 &&
      reference.role === originalCodeManifest.role
        ? mislabelledCodeManifest
        : reference,
    )
    await Promise.all([
      writeFile(observationPath, canonicalJson(observation)),
      writeFile(manifestPath, canonicalJson(manifest)),
    ])
    const common = await git(
      value.repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    )
    const journalPath = join(common, 'factory-runtime', 'journal-v1', 'journal.sqlite')
    let database = new Database(journalPath)
    database.run('DELETE FROM completions')
    database.close(false)
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        `${JSON.stringify({ session_id: 'rewritten-graph', hook_event_name: 'SessionEnd', cwd: value.repository })}\n`,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    expect(
      JSON.parse((await command(value.factory, ['doctor'], value.repository, value.env)).stdout)
        .pendingStops,
    ).toBe(1)

    await Promise.all([
      writeFile(observationPath, originalObservation),
      writeFile(manifestPath, originalManifest),
    ])
    Object.assign(manifest, JSON.parse(originalManifest))
    const omitted = manifest.rawObjects[0]
    manifest.rawObjects = manifest.rawObjects.slice(1)
    manifest.inventory = manifest.inventory.filter(
      (reference: { sha256: string }) => reference.sha256 !== omitted.sha256,
    )
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    database = new Database(journalPath)
    database.run('DELETE FROM completions')
    database.close(false)
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        `${JSON.stringify({ session_id: 'rewritten-graph', hook_event_name: 'SessionEnd', cwd: value.repository })}\n`,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const parsedDoctor = await command(value.factory, ['doctor'], value.repository, value.env)
    expect(parsedDoctor.code, parsedDoctor.stderr).toBe(0)
    expect(JSON.parse(parsedDoctor.stdout).pendingStops).toBe(1)

    await writeFile(manifestPath, originalManifest)
    const eventsPath = join(turnsRoot, turnId, 'events.jsonl')
    const originalEvents = await readFile(eventsPath, 'utf8')
    const eventRows = originalEvents
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    eventRows[0].parsed = { misleading: true }
    await writeFile(eventsPath, eventRows.map(value => canonicalJson(value)).join(''))
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        stop,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const envelopeDoctor = await command(value.factory, ['doctor'], value.repository, value.env)
    expect(envelopeDoctor.code, envelopeDoctor.stderr).toBe(0)
    expect(JSON.parse(envelopeDoctor.stdout).pendingStops).toBe(1)

    await writeFile(eventsPath, originalEvents)
    const triggerRoot = join(value.repository, '.factory', 'review-triggers')
    const triggerPath = join(triggerRoot, (await readdir(triggerRoot))[0]!)
    const trigger = JSON.parse(await readFile(triggerPath, 'utf8'))
    trigger.createdAt = '2026-01-01T00:00:00.000Z'
    await writeFile(triggerPath, `${JSON.stringify(trigger)}\n`)
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        stop,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const rewritten = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(rewritten.pendingStops).toBe(1)
    expect(rewritten.projection.triggers).toBe(1)
    expect(rewritten.captureDiagnostics.length).toBeGreaterThan(1)
  })

  test('keeps observation limitations authoritative during completion recovery', async () => {
    const value = await createFixture()
    expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
    await symlink('../outside', join(value.repository, 'unsafe-link'))
    const stop = `${JSON.stringify({ session_id: 'limited-graph', hook_event_name: 'Stop', turn_id: 'limited-stop', cwd: value.repository })}\n`
    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        stop,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const initial = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    const sessionKey = initial.projection.sessions[0].sessionKey
    const turnsRoot = join(value.repository, '.factory', 'sessions', 'codex', sessionKey, 'turns')
    const turnId = (await readdir(turnsRoot))[0]!
    const manifestPath = join(turnsRoot, turnId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(manifest.limitations.length).toBeGreaterThan(1)
    manifest.limitations = manifest.limitations.filter(
      (limitation: { code: string }) => limitation.code === 'missing-transcript-range',
    )
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    const triggerRoot = join(value.repository, '.factory', 'review-triggers')
    const triggerPath = join(triggerRoot, (await readdir(triggerRoot))[0]!)
    const trigger = JSON.parse(await readFile(triggerPath, 'utf8'))
    trigger.limitations = manifest.limitations
    trigger.materialization = 'partial'
    await writeFile(triggerPath, `${JSON.stringify(trigger)}\n`)
    const common = await git(
      value.repository,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    )
    const database = new Database(join(common, 'factory-runtime', 'journal-v1', 'journal.sqlite'))
    database.run('DELETE FROM completions')
    database.close(false)

    expect(
      await command(
        value.factory,
        ['capture', '--provider', 'codex'],
        value.repository,
        value.env,
        `${JSON.stringify({ session_id: 'limited-graph', hook_event_name: 'SessionEnd', cwd: value.repository })}\n`,
      ),
    ).toMatchObject({ code: 0, stdout: '{}\n' })
    const damaged = JSON.parse(
      (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
    )
    expect(damaged.pendingStops).toBe(1)
    expect(damaged.captureDiagnostics.length).toBeGreaterThan(0)
  })

  test('derives identical limitations when resuming immutable prefixes', async () => {
    for (const scenario of ['lagging-transcript', 'missing-transcript', 'raced-observation']) {
      const value = await createFixture()
      expect((await command(value.factory, ['init'], value.repository, value.env)).code).toBe(0)
      const transcript = join(value.home, '.codex', 'sessions', `${scenario}.jsonl`)
      if (scenario === 'lagging-transcript') await writeFile(transcript, '{"message":"older"}\n')
      const payload = {
        session_id: `prefix-${scenario}`,
        hook_event_name: 'Stop',
        turn_id: `stop-${scenario}`,
        cwd: value.repository,
        ...(scenario === 'lagging-transcript'
          ? { transcript_path: transcript, last_assistant_message: 'newer' }
          : {}),
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
      const initial = JSON.parse(
        (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
      )
      const sessionKey = initial.projection.sessions[0].sessionKey
      const turnsRoot = join(value.repository, '.factory', 'sessions', 'codex', sessionKey, 'turns')
      const turnId = (await readdir(turnsRoot))[0]!
      const manifestPath = join(turnsRoot, turnId, 'manifest.json')
      const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const observationPath = join(
        value.repository,
        '.factory',
        'repository-observations',
        `${originalManifest.repositoryObservationId}.json`,
      )
      if (scenario === 'raced-observation') {
        const observation = JSON.parse(await readFile(observationPath, 'utf8'))
        observation.startState = 'a'.repeat(64)
        observation.endState = 'b'.repeat(64)
        observation.limitations.push({
          code: 'repository-race',
          detail: 'Git state changed during observation',
        })
        await writeFile(observationPath, canonicalJson(observation))
      }
      const triggerRoot = join(value.repository, '.factory', 'review-triggers')
      await Promise.all([
        unlink(manifestPath),
        unlink(join(triggerRoot, (await readdir(triggerRoot))[0]!)),
      ])
      const common = await git(
        value.repository,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      )
      const journalPath = join(common, 'factory-runtime', 'journal-v1', 'journal.sqlite')
      let database = new Database(journalPath)
      database.run('DELETE FROM completions')
      database.close(false)

      expect(
        await command(
          value.factory,
          ['capture', '--provider', 'codex'],
          value.repository,
          value.env,
          `${JSON.stringify({ session_id: `prefix-${scenario}`, hook_event_name: 'SessionEnd', cwd: value.repository })}\n`,
        ),
      ).toMatchObject({ code: 0, stdout: '{}\n' })
      const resumedManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (scenario === 'raced-observation') {
        expect(resumedManifest.limitations).toContainEqual({
          code: 'repository-race',
          detail: `repository changed from ${'a'.repeat(64)} to ${'b'.repeat(64)}`,
        })
      } else {
        expect(resumedManifest.limitations).toContainEqual({
          code: 'missing-transcript-range',
          detail:
            scenario === 'lagging-transcript'
              ? 'provider transcript lags the Stop assistant message'
              : 'Stop did not expose a provider transcript path',
        })
      }

      database = new Database(journalPath)
      database.run('DELETE FROM completions')
      database.close(false)
      expect(
        await command(
          value.factory,
          ['capture', '--provider', 'codex'],
          value.repository,
          value.env,
          `${JSON.stringify(payload)}\n`,
        ),
      ).toMatchObject({ code: 0, stdout: '{}\n' })
      const recovered = JSON.parse(
        (await command(value.factory, ['doctor'], value.repository, value.env)).stdout,
      )
      if (recovered.pendingStops !== 0) {
        const diagnostic = await readFile(
          join(
            common,
            'factory-runtime',
            'journal-v1',
            'diagnostics',
            recovered.captureDiagnostics[0],
          ),
          'utf8',
        )
        throw new Error(
          `${scenario} remained pending: ${JSON.stringify(recovered)} diagnostic=${diagnostic}`,
        )
      }
    }
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
