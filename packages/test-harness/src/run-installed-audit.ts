import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { verifyReleaseArtifact } from '@factory/cli'
import {
  decodeGitPath,
  objectOwnedPath,
  type ReviewLedger,
  type TurnManifest,
} from '@factory/contract'
import { buildUiProjection, loadStoredReviews } from '@factory/domain'
import {
  RepositoryStore,
  loadCodeManifestObject,
  reconstructCodeManifest,
  readConfinedFile,
} from '@factory/repository'
import type { StoredReviewResult } from '@factory/review'

import { command, replayProvider, succeed, openAndConfirmDecision } from './release-fixtures'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
function required(name: string): string {
  const value = option(name)
  if (!value) throw new Error(`${name} is required`)
  return value
}
const repositorySource = resolve(import.meta.dir, '../../..')
const archivePath = resolve(required('--archive'))
const manifestPath = resolve(required('--manifest'))
const manifestHash = required('--manifest-sha256')
const secret = 'fixture-env-secret-9a7f3e21'
const token = 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'
const reasoning =
  `Reasoning begins ${secret} ` +
  'Retain the implementation reasoning. '.repeat(180) +
  ' Reasoning ends.'
const toolResult = `Result begins ${secret} ` + '😀'.repeat(4500) + ` ${token} Result ends.`

async function replayRefusedStop(
  repository: string,
  home: string,
  deliver: () => Promise<void>,
): Promise<void> {
  const expectedCode = 'export const retained = true\n// Synthetic context [REDACTED]\n'
  const obstruction = join(
    repository,
    '.factory',
    objectOwnedPath(createHash('sha256').update(expectedCode).digest('hex')),
  )
  await mkdir(obstruction, { recursive: true })
  await deliver()
  const database = new Database(
    join(repository, '.git/factory-runtime/journal-v1/journal.sqlite'),
    { readonly: true },
  )
  try {
    assert.equal(
      (
        database
          .query("SELECT count(*) AS count FROM capture_preparations WHERE owner_key LIKE 'stop:%'")
          .get() as { count: number }
      ).count,
      1,
      'refused publication must retain its frozen private preparation',
    )
  } finally {
    database.close()
  }
  const store = await RepositoryStore.open(repository)
  assert.ok(
    !(await store.readRecords()).records.some(record =>
      /\/turns\/[^/]+\/manifest.json$/.test(record.path),
    ),
    'refused publication must not acknowledge a Turn',
  )
  await scanPortableTree(join(repository, '.factory'))
  await rmdir(obstruction)
  const env = join(repository, 'ignored/nested/.env.local')
  const transcript = join(home, '.codex/sessions/certification.jsonl')
  const original = await readFile(transcript)
  await unlink(env)
  await unlink(transcript)
  await deliver()
  await assert.rejects(readFile(transcript), { code: 'ENOENT' })
  const turn = (await store.readRecords()).records.find(record =>
    /\/turns\/[^/]+\/manifest.json$/.test(record.path),
  )!.value as unknown as TurnManifest
  const safeTranscript = new TextDecoder().decode(
    await store.getObject(turn.transcriptObservations[0]!),
  )
  assert.ok(safeTranscript.includes(reasoning.replaceAll(secret, '[REDACTED]')))
  assert.ok(!safeTranscript.includes(secret))
  await writeFile(transcript, original)
  await writeFile(env, `VALUE=${secret}\n`)
}

async function readAcceptedLedger(
  repository: string,
  result: StoredReviewResult,
): Promise<ReviewLedger> {
  assert.ok(
    result.paths.ledger,
    'installed review must execute from its read-only bundle snapshot and accept submitted choices',
  )
  const text = await readFile(join(repository, '.factory', result.paths.ledger), 'utf8')
  assert.ok(
    !text.includes(secret) && !text.includes(token),
    'accepted model output leaked seeded secrets',
  )
  const ledger = JSON.parse(text) as ReviewLedger
  assert.deepEqual(ledger.entries.map(entry => entry.verdict).sort(), [
    'needs-user',
    'sound',
    'unsound',
  ])
  for (const entry of ledger.entries)
    assert.equal(entry.headline, `${entry.verdict} synthetic decision [REDACTED] [REDACTED]`)
  return ledger
}

async function verifyPortableClone(
  repository: string,
  scratch: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await succeed('git', ['add', '.factory'], repository, environment)
  await succeed('git', ['commit', '-m', 'Commit synthetic portable audit'], repository, environment)
  const clone = join(scratch, 'clone')
  await succeed(
    'git',
    ['clone', '--no-local', '--no-checkout', repository, clone],
    scratch,
    environment,
  )
  await succeed('git', ['checkout', 'HEAD', '--', '.factory'], clone, environment)
  await assert.rejects(readFile(join(clone, 'ignored/nested/.env.local')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(clone, 'app.ts')), { code: 'ENOENT' })
  await assert.rejects(readdir(join(clone, '.git/factory-runtime')), { code: 'ENOENT' })
  const source = await RepositoryStore.open(repository)
  const restored = await RepositoryStore.open(clone)
  const records = await restored.readRecords()
  assert.deepEqual(records, await source.readRecords())
  assert.deepEqual((await restored.verify()).issues, [])
  const projection = buildUiProjection(records)
  assert.deepEqual(projection, buildUiProjection(await source.readRecords()))
  assert.equal(projection.state, 'ready')
  assert.ok(projection.decisions)
  assert.deepEqual(
    projection.decisions.groups.map(group => group.verdict),
    ['needs-user', 'unsound', 'sound'],
  )
  for (const group of projection.decisions.groups) {
    assert.ok(group.choices.length > 0)
    if (group.verdict !== 'sound')
      assert.ok(group.choices.every(choice => 'priority' in choice && choice.priority === 'high'))
  }
  const reviews = loadStoredReviews(records.records)
  assert.ok(reviews.length > 0)
  const reconstructed = new Set<string>()
  for (const review of reviews) {
    assert.ok(review.ledger)
    for (const citation of [
      ...review.ledger.entries.flatMap(entry => entry.evidence),
      ...(review.ledger.summary?.evidence ?? []),
    ])
      await restored.getObject(citation.object)
    const ref = review.manifest.codeManifest
    if (ref === undefined) {
      assert.equal(
        review.manifest.subject.kind,
        'pull-request',
        'workspace reviews retain reconstructable code',
      )
      assert.ok(review.manifest.patches.length > 0)
      const patches = (
        await Promise.all(review.manifest.patches.map(object => restored.getObject(object)))
      )
        .map(bytes => new TextDecoder().decode(bytes))
        .join('\n')
      assert.ok(patches.includes('+export const pullRequest = true'))
      assert.ok(!patches.includes('.env.review') && !patches.includes('GIT binary patch'))
      continue
    }
    if (reconstructed.has(ref.sha256)) continue
    reconstructed.add(ref.sha256)
    const destination = join(scratch, `reconstructed-${ref.sha256}`)
    await mkdir(destination)
    await reconstructCodeManifest(
      await loadCodeManifestObject(ref, object => restored.getObject(object)),
      destination,
      object => restored.getObject(object),
    )
    assert.equal(
      await readFile(join(destination, 'app.ts'), 'utf8'),
      'export const retained = true\n// Synthetic context [REDACTED]\n',
    )
    await assert.rejects(readFile(join(destination, 'asset.bin')), { code: 'ENOENT' })
  }
  await scanPortableTree(join(clone, '.factory'))
}

async function preparePullRequestFixture(
  repository: string,
  scratch: string,
  bin: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const base = (await succeed('git', ['rev-parse', 'HEAD'], repository, environment)).stdout.trim()
  await writeFile(
    join(repository, 'app.ts'),
    `export const retained = true\n// Synthetic context ${secret}\nexport const pullRequest = true\n`,
  )
  await writeFile(join(repository, '.env.review'), `VALUE=${secret}\n`)
  await writeFile(
    join(repository, 'asset.bin'),
    Buffer.concat([Buffer.from([0, 255]), Buffer.from(secret)]),
  )
  await succeed('git', ['add', 'app.ts', '.env.review', 'asset.bin'], repository, environment)
  await succeed('git', ['commit', '-m', 'Synthetic pull request source'], repository, environment)
  const head = (await succeed('git', ['rev-parse', 'HEAD'], repository, environment)).stdout.trim()
  const identity = {
    id: 'R_fixture',
    nameWithOwner: 'fixture/audit',
    url: 'https://github.com/fixture/audit',
  }
  await writeFile(
    join(scratch, 'gh-repository.json'),
    JSON.stringify({ ...identity, defaultBranchRef: { name: 'main' } }),
  )
  await writeFile(
    join(scratch, 'gh-pull-request.json'),
    JSON.stringify({
      data: {
        repository: {
          ...identity,
          pullRequest: {
            id: 'PR_fixture_42',
            url: 'https://github.com/fixture/audit/pull/42',
            number: 42,
            state: 'OPEN',
            mergedAt: null,
            title: `Synthetic PR ${secret}`,
            body: `Synthetic PR body ${token}`,
            baseRefName: 'main',
            baseRefOid: base,
            headRefName: 'feature',
            headRefOid: head,
            updatedAt: '2026-09-05T00:00:00Z',
            headRepository: identity,
            commits: {
              nodes: [{ commit: { oid: head } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }),
  )
  await writeFile(
    join(scratch, 'gh-patch.diff'),
    (await succeed('git', ['diff', '--binary', base, head], repository, environment)).stdout,
  )
  const gh = join(bin, 'gh')
  await writeFile(
    gh,
    `#!/bin/sh\ncase "$1:$2" in\nrepo:view) exec cat '${scratch}/gh-repository.json' ;;\npr:diff) exec cat '${scratch}/gh-patch.diff' ;;\napi:*) for arg; do if [ "$arg" = graphql ]; then exec cat '${scratch}/gh-pull-request.json'; fi; done; exit 3 ;;\n*) exit 3 ;;\nesac\n`,
  )
  await chmod(gh, 0o755)
}

async function scanPortableTree(root: string): Promise<number> {
  const safe = (text: string) =>
    assert.ok(
      !text.includes(secret) && !text.includes(token),
      'physical or decoded portable evidence leaked seeded secrets',
    )
  const decoded = (value: unknown): void => {
    if (typeof value === 'string') safe(value)
    else if (Array.isArray(value)) value.forEach(decoded)
    else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        safe(key)
        decoded(child)
      }
      if (
        'encoding' in value &&
        value.encoding === 'base64' &&
        'bytes' in value &&
        typeof value.bytes === 'string'
      )
        safe(Buffer.from(value.bytes, 'base64').toString())
    }
  }
  let files = 0
  let entries = 0
  let totalBytes = 0
  const visit = async (path: string, depth = 0): Promise<void> => {
    assert.ok(depth < 16, 'fixture tree depth remains bounded')
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.ok(++entries < 20000, 'fixture traversal remains bounded')
      safe(entry.name)
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child, depth + 1)
      else {
        assert.ok(entry.isFile(), 'portable fixture must contain only ordinary files')
        assert.ok(++files < 10000, 'fixture scan remains bounded')
        const bytes = await readConfinedFile(
          root,
          relative(root, child)
            .split('/')
            .map(segment => new TextEncoder().encode(segment)),
          { maximumBytes: 16 * 1024 * 1024 },
        )
        totalBytes += bytes.byteLength
        assert.ok(totalBytes < 64 * 1024 * 1024, 'fixture aggregate remains bounded')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        safe(text)
        try {
          decoded(JSON.parse(text))
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          for (const line of text.split('\n')) {
            try {
              decoded(JSON.parse(line))
            } catch (lineError) {
              if (!(lineError instanceof SyntaxError)) throw lineError
            }
          }
        }
      }
    }
  }
  await visit(root)
  return files
}

async function proveScannerFindsUnreferencedEncodedSecrets(repository: string): Promise<void> {
  const root = join(repository, '.factory')
  const escapedKey = Array.from(secret)
    .map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('')
  for (const text of [
    JSON.stringify({ [secret]: 'synthetic scanner sentinel' }).replace(secret, escapedKey),
    JSON.stringify({ encoding: 'base64', bytes: Buffer.from(secret).toString('base64') }),
  ]) {
    assert.ok(!text.includes(secret), 'negative control must require decoding')
    const target = join(root, objectOwnedPath(createHash('sha256').update(text).digest('hex')))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text, { flag: 'wx' })
    try {
      await assert.rejects(scanPortableTree(root), /portable evidence leaked seeded secrets/)
    } finally {
      await unlink(target)
    }
  }
}

async function inspectCapturedEvidence(
  repository: string,
  home: string,
  scratch: string,
): Promise<void> {
  const store = await RepositoryStore.open(repository)
  const records = await store.readRecords()
  for (const provider of ['codex', 'claude'] as const) {
    const turns = records.records.filter(
      record =>
        record.path.startsWith(`sessions/${provider}/`) &&
        /\/turns\/[^/]+\/manifest.json$/.test(record.path),
    )
    assert.equal(turns.length, 1, `${provider} must persist its exact synthetic Stop`)
    const turn = turns[0]!.value as unknown as TurnManifest
    assert.equal(turn.transcriptObservations.length, 1)
    const transcript = new TextDecoder().decode(
      await store.getObject(turn.transcriptObservations[0]!),
    )
    const rows = transcript
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    const result =
      provider === 'codex'
        ? rows.find(row => row.payload?.type === 'function_call_output').payload.output
        : rows
            .flatMap(row => (Array.isArray(row.message?.content) ? row.message.content : []))
            .find(block => block.type === 'tool_result').content
    const redacted = Array.from(
      toolResult.replaceAll(secret, '[REDACTED]').replaceAll(token, '[REDACTED]'),
    )
    assert.equal(
      result,
      redacted.slice(0, 3000).join('') +
        `\n[Factory omitted ${redacted.length - 4000} characters]\n` +
        redacted.slice(-1000).join(''),
    )
    const hooks = await Promise.all(
      turn.evidenceObjects.map(async ref =>
        JSON.parse(new TextDecoder().decode(await store.getObject(ref))),
      ),
    )
    const postTool = hooks.find(hook => hook.hook_event_name === 'PostToolUse')
    assert.equal(
      provider === 'codex' ? postTool.tool_response.output : postTool.tool_response.stdout,
      result,
    )
    const assistant =
      provider === 'codex'
        ? rows.find(row => row.payload?.role === 'assistant').payload.content[0].text
        : rows.find(
            row =>
              row.message?.role === 'assistant' &&
              row.message.content.some((block: { type: string }) => block.type === 'text'),
          ).message.content[0].text
    assert.equal(assistant, reasoning.replaceAll(secret, '[REDACTED]'))
    assert.ok(Array.from(assistant).length > 4000)
    const user =
      provider === 'codex'
        ? rows.find(row => row.payload?.role === 'user').payload.content[0].text
        : rows.find(row => row.message?.role === 'user' && typeof row.message.content === 'string')
            .message.content
    assert.equal(user, reasoning.replaceAll(secret, '[REDACTED]'))
    assert.ok(
      rows.some(row => row.type === `future_${provider}_record`),
      'readable unknown provider records remain visible',
    )
    const original = join(
      home,
      provider === 'codex'
        ? '.codex/sessions/certification.jsonl'
        : '.claude/projects/certification.jsonl',
    )
    assert.deepEqual(
      await readFile(original),
      await readFile(join(scratch, 'fixtures', provider, 'transcript.jsonl')),
      'provider originals must remain untouched',
    )
    assert.ok(turn.codeManifest)
    const code = await loadCodeManifestObject(turn.codeManifest, ref => store.getObject(ref))
    assert.deepEqual(
      code.entries.map(entry => Buffer.from(decodeGitPath(entry.path)).toString()).sort(),
      ['.gitignore', 'app.ts'],
    )
    const app = code.entries.find(
      entry => Buffer.from(decodeGitPath(entry.path)).toString() === 'app.ts',
    )!
    assert.ok(app.kind !== 'gitlink')
    assert.equal(
      new TextDecoder().decode(await store.getObject(app.object)),
      'export const retained = true\n// Synthetic context [REDACTED]\n',
    )
  }
}

async function providerFixture(provider: 'codex' | 'claude', scratch: string): Promise<string> {
  const source = join(import.meta.dir, '../fixtures/providers', provider)
  const destination = join(scratch, 'fixtures', provider)
  await mkdir(destination, { recursive: true })
  const transcript =
    (await readFile(join(source, 'transcript.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => {
        const row = JSON.parse(line)
        if (provider === 'codex') {
          if (row.payload?.type === 'function_call_output') row.payload.output = toolResult
          if (row.payload?.type === 'message') row.payload.content[0].text = reasoning
        } else if (row.message) {
          if (typeof row.message.content === 'string') row.message.content = reasoning
          for (const block of Array.isArray(row.message.content) ? row.message.content : []) {
            if (block.type === 'tool_result') block.content = toolResult
            if (block.type === 'text') block.text = reasoning
          }
        }
        row.synthetic = { [secret]: { retained: `context ${token}` } }
        return JSON.stringify(row)
      })
      .join('\n') + '\n'
  const hooks =
    (await readFile(join(source, 'hooks.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => {
        const row = JSON.parse(line)
        if (row.hook_event_name === 'PostToolUse')
          row.tool_response =
            provider === 'codex'
              ? { output: toolResult, exit_code: 0 }
              : { stdout: toolResult, stderr: '' }
        if (row.hook_event_name === 'UserPromptSubmit') row.prompt = reasoning
        if (row.last_assistant_message !== undefined) row.last_assistant_message = reasoning
        return JSON.stringify(row)
      })
      .join('\n') + '\n'
  await writeFile(join(destination, 'transcript.jsonl'), transcript)
  await writeFile(join(destination, 'hooks.jsonl'), hooks)
  return destination
}

if (!process.argv.includes('--inside')) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'factory-installed-audit-')))
  const outer = (
    await succeed(
      'docker',
      [
        'build',
        '--platform',
        'linux/amd64',
        '-q',
        '-f',
        join(repositorySource, 'packages/test-harness/docker/installed-audit/Dockerfile'),
        repositorySource,
      ],
      repositorySource,
      process.env,
    )
  ).stdout.trim()
  const reviewer = (
    await succeed(
      'docker',
      [
        'build',
        '-q',
        '-f',
        join(repositorySource, 'packages/test-harness/docker/reviewer-isolation/Dockerfile'),
        repositorySource,
      ],
      repositorySource,
      process.env,
    )
  ).stdout.trim()
  const socketGroup = (
    await succeed(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--platform',
        'linux/amd64',
        '--mount',
        'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly',
        outer,
        'stat',
        '-c',
        '%g',
        '/var/run/docker.sock',
      ],
      repositorySource,
      process.env,
    )
  ).stdout.trim()
  assert.match(socketGroup, /^\d+$/, 'Docker socket must have a numeric group')
  process.stdout.write(`Installed audit scratch: ${scratch}\n`)
  const containerName = basename(scratch).toLowerCase()
  try {
    await succeed(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        containerName,
        '--platform',
        'linux/amd64',
        '--network',
        'none',
        '--user',
        `${process.getuid!()}:${process.getgid!()}`,
        '--group-add',
        socketGroup,
        ...[...new Set([repositorySource, dirname(archivePath), dirname(manifestPath)])].flatMap(
          path => ['--mount', `type=bind,src=${path},dst=${path},readonly`],
        ),
        '--mount',
        `type=bind,src=${scratch},dst=${scratch}`,
        '--mount',
        'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
        '--workdir',
        repositorySource,
        outer,
        '/opt/harness/bun',
        'run',
        join(import.meta.dir, 'run-installed-audit.ts'),
        '--inside',
        '--scratch',
        scratch,
        '--archive',
        archivePath,
        '--manifest',
        manifestPath,
        '--manifest-sha256',
        manifestHash,
        '--reviewer-image',
        reviewer,
      ],
      repositorySource,
      process.env,
    )
  } finally {
    const cleanup = await command(
      'docker',
      ['rm', '--force', containerName],
      repositorySource,
      process.env,
    )
    assert.ok(
      cleanup.code === 0 || cleanup.stderr.includes('No such container'),
      'outer test container cleanup must be observed',
    )
  }
  process.stdout.write(`${await readFile(join(scratch, 'report.json'), 'utf8')}\n`)
} else {
  const scratch = required('--scratch')
  const release = await verifyReleaseArtifact({
    archive: new Uint8Array(await readFile(archivePath)),
    adjacentManifest: new Uint8Array(await readFile(manifestPath)),
    expectedManifestSha256: manifestHash,
    expectedTarget: 'bun-linux-x64-baseline',
  })
  const checks: string[] = []
  const checked = async (name: string): Promise<void> => {
    checks.push(name)
    await writeFile(
      join(scratch, 'progress.json'),
      JSON.stringify({ status: 'running', revision: release.revision, checks }, null, 2),
    )
  }
  await checked('verified-native-release-artifact')
  const home = join(scratch, 'home')
  const repository = join(scratch, 'repository')
  const bin = join(scratch, 'bin')
  await Promise.all([mkdir(home), mkdir(repository), mkdir(bin)])
  const executable = join(bin, 'factory')
  await writeFile(executable, release.executable, { mode: 0o755 })
  await chmod(executable, 0o755)
  const environment = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.state'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PATH: `${bin}:/usr/bin:/bin`,
  }
  assert.notEqual((await command('sh', ['-c', 'command -v bun'], repository, environment)).code, 0)
  const commands: string[][] = []
  const run = (args: string[], env: NodeJS.ProcessEnv = environment) => {
    commands.push(args)
    return succeed(executable, args, repository, env)
  }
  await succeed('git', ['init', '-b', 'main'], repository, environment)
  await succeed('git', ['config', 'user.email', 'factory@example.invalid'], repository, environment)
  await succeed('git', ['config', 'user.name', 'Factory Installed Audit'], repository, environment)
  await writeFile(
    join(repository, 'app.ts'),
    `export const retained = true\n// Synthetic context ${secret}\n`,
  )
  await writeFile(join(repository, 'asset.bin'), new Uint8Array([0, 255, 1, 2]))
  await writeFile(join(repository, '.gitignore'), 'ignored/\n')
  await mkdir(join(repository, 'ignored', 'nested'), { recursive: true })
  await writeFile(join(repository, 'ignored', 'nested', '.env.local'), `VALUE=${secret}\n`)
  await succeed('git', ['add', '.'], repository, environment)
  await succeed('git', ['commit', '-m', 'synthetic audit fixture'], repository, environment)
  await run(['init', '--canonical-branch', 'main'])
  await run(['install'])
  for (const provider of ['codex', 'claude'] as const)
    await replayProvider(provider, executable, repository, home, environment, {
      fixtureRoot: await providerFixture(provider, scratch),
      assistantMessage: reasoning,
      ...(provider === 'codex'
        ? {
            deliverStop: (deliver: () => Promise<void>) =>
              replayRefusedStop(repository, home, deliver),
          }
        : {}),
    })
  await inspectCapturedEvidence(repository, home, scratch)
  await checked('both-provider-native-capture-originals-prose-result-budget-source-omissions')
  await checked('native-refused-cas-publication-frozen-stop-replay-without-env-or-transcript')
  const auth = join(scratch, 'auth.json')
  await writeFile(auth, 'factory-test-verdicts factory-test-sanitization\n', { mode: 0o600 })
  await chmod(auth, 0o600)
  const reviewEnvironment = {
    ...environment,
    FACTORY_CODEX_AUTH_FILE: auth,
    FACTORY_CLAUDE_AUTH_FILE: join(scratch, 'absent-auth'),
    FACTORY_REVIEWER_IMAGE: required('--reviewer-image'),
    FACTORY_CODEX_REVIEW_MODEL: 'gpt-test',
    FACTORY_CODEX_REVIEW_EFFORT: 'high',
  }
  const result = JSON.parse((await run(['review'], reviewEnvironment)).stdout) as StoredReviewResult
  const ledger = await readAcceptedLedger(repository, result)
  await checked('codex-complete-submission-three-redacted-verdicts')
  const dockerTrap = join(bin, 'docker')
  await openAndConfirmDecision(executable, repository, reviewEnvironment, {
    note: `Human fixture note ${secret} ${token}`,
    acceptCoverageReviewId: result.reviewId,
    beforeDecisionRetry: () =>
      writeFile(join(repository, 'ignored/nested/.env.local'), 'VALUE=rotated-fixture-env-value\n'),
  })
  await writeFile(join(repository, 'ignored/nested/.env.local'), `VALUE=${secret}\n`)
  const actions = (await (await RepositoryStore.open(repository)).readRecords()).records.filter(
    record => record.path.startsWith('decisions/actions/'),
  )
  assert.equal(actions.length, 1)
  assert.equal(
    (actions[0]!.value as { note: string }).note,
    'Human fixture note [REDACTED] [REDACTED]',
  )
  await checked('localhost-secret-note-env-rotation-retry-and-partial-coverage-acceptance')
  await writeFile(dockerTrap, '#!/bin/sh\nprintf invoked > "$0.invoked"\nexit 77\n')
  await chmod(dockerTrap, 0o755)
  const repeated = JSON.parse(
    (await run(['review'], reviewEnvironment)).stdout,
  ) as StoredReviewResult
  assert.equal(repeated.status, 'already-reviewed')
  assert.equal(repeated.reviewId, result.reviewId)
  assert.deepEqual(repeated.paths, result.paths)
  await assert.rejects(readFile(`${dockerTrap}.invoked`), { code: 'ENOENT' })
  await unlink(dockerTrap)
  await checked('unchanged-review-no-docker-trap')
  const reviews = [result]
  for (const provider of ['claude', 'codex'] as const) {
    await run(['configure', '--repo', '--reviewer', provider])
    const selectedEnvironment = {
      ...reviewEnvironment,
      FACTORY_CLAUDE_AUTH_FILE: auth,
      FACTORY_CLAUDE_REVIEW_MODEL: 'claude-test',
      FACTORY_CLAUDE_REVIEW_EFFORT: 'high',
    }
    for (const interrupted of [false, true]) {
      await writeFile(
        auth,
        `factory-test-verdicts factory-test-sanitization${interrupted ? ' factory-test-prefix-nonzero' : ''}\n`,
      )
      commands.push(['review', '--force'])
      const invocation = await command(
        executable,
        ['review', '--force'],
        repository,
        selectedEnvironment,
      )
      assert.equal(
        invocation.code,
        interrupted ? 1 : 0,
        'CLI exit status must retain execution failure independently of accepted partial choices',
      )
      const reviewed = JSON.parse(invocation.stdout) as StoredReviewResult
      assert.equal(reviewed.reviewer.provider, provider)
      if (!interrupted) assert.equal(reviewed.reviewer.version, `${provider}-fake/1`)
      await readAcceptedLedger(repository, reviewed)
      if (interrupted) {
        assert.equal(reviewed.disposition, 'partial')
        assert.ok(reviewed.limitations.some(item => item.code === 'invalid-review-output'))
      }
      const submissions = (
        await readFile(join(repository, '.factory', reviewed.paths.submissions), 'utf8')
      )
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line))
      assert.equal(
        submissions.some(event => event.kind === 'finish'),
        !interrupted,
      )
      reviews.push(reviewed)
      await checked(
        `${provider}-${interrupted ? 'unfinished-prefix' : 'complete-submission'}-three-redacted-verdicts`,
      )
    }
  }
  await preparePullRequestFixture(repository, scratch, bin, environment)
  await writeFile(auth, 'factory-test-verdicts factory-test-sanitization\n')
  const pullRequest = JSON.parse(
    (await run(['review', '--pr', '42', '--force'], reviewEnvironment)).stdout,
  ) as StoredReviewResult
  await readAcceptedLedger(repository, pullRequest)
  const pullRequestManifest = JSON.parse(
    await readFile(join(repository, '.factory', pullRequest.paths.manifest), 'utf8'),
  )
  assert.equal(pullRequestManifest.subject.kind, 'pull-request')
  assert.equal(pullRequestManifest.subject.number, 42)
  reviews.push(pullRequest)
  await checked('pull-request-native-review')
  await inspectCapturedEvidence(repository, home, scratch)
  await proveScannerFindsUnreferencedEncodedSecrets(repository)
  await checked('scanner-negative-controls-unreferenced-escaped-json-key-and-encoded-path')
  await verifyPortableClone(repository, scratch, environment)
  await checked('committed-clone-without-env-journal-source-reconstruction-citations-ui-projection')
  const physicalFiles = await scanPortableTree(join(repository, '.factory'))
  await checked('all-physical-factory-files-and-decoded-json-paths')
  await writeFile(
    join(scratch, 'report.json'),
    JSON.stringify(
      {
        status: 'passed',
        release: {
          version: release.version,
          revision: release.revision,
          manifestSha256: manifestHash,
          executableSha256: createHash('sha256').update(release.executable).digest('hex'),
        },
        authority: {
          execution:
            'Verified native installed CLI; real isolated MCP/repository owners; no Bun on consumer PATH',
          providers:
            'Synthetic executables and private-mode synthetic credentials; no authenticated model judgment',
          pullRequest:
            'Synthetic gh patch and metadata through the real adapter; optional exact-SHA PR code capture is not requested by the CLI',
          recovery:
            'Selected-CAS publication refusal and frozen native Stop replay without env/transcript; earlier safe object prefixes are allowed. SIGKILL/all-prefix recovery and concurrent serialization require their separate Docker gates',
        },
        checks,
        commands,
        physicalFiles,
        reviews: reviews.map(({ reviewId, reviewer, disposition, executionFailed, paths }) => ({
          reviewId,
          reviewer,
          disposition,
          executionFailed,
          paths,
        })),
        ledger,
      },
      null,
      2,
    ),
  )
}
