import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { verifyReleaseArtifact } from '@factory/cli'
import type { ReviewLedger } from '@factory/contract'
import type { StoredReviewResult } from '@factory/review'

import { command, replayProvider, succeed } from './release-fixtures'

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
          if (row.payload?.type === 'message' && row.payload.role === 'assistant')
            row.payload.content[0].text = reasoning
        } else if (row.message) {
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
          row.tool_response = { stdout: toolResult, stderr: '' }
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
  await succeed(
    'docker',
    [
      'run',
      '--rm',
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
  process.stdout.write(`${await readFile(join(scratch, 'report.json'), 'utf8')}\n`)
} else {
  const scratch = required('--scratch')
  const release = await verifyReleaseArtifact({
    archive: new Uint8Array(await readFile(archivePath)),
    adjacentManifest: new Uint8Array(await readFile(manifestPath)),
    expectedManifestSha256: manifestHash,
    expectedTarget: 'bun-linux-x64-baseline',
  })
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
  const run = (args: readonly string[], env: NodeJS.ProcessEnv = environment) =>
    succeed(executable, args, repository, env)
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
    await replayProvider(
      provider,
      executable,
      repository,
      home,
      environment,
      false,
      await providerFixture(provider, scratch),
    )
  const auth = join(scratch, 'auth.json')
  await writeFile(auth, 'factory-test-verdicts factory-test-sanitization\n', { mode: 0o444 })
  await chmod(auth, 0o444)
  const result = JSON.parse(
    (
      await run(['review'], {
        ...environment,
        FACTORY_CODEX_AUTH_FILE: auth,
        FACTORY_CLAUDE_AUTH_FILE: join(scratch, 'absent-auth'),
        FACTORY_REVIEWER_IMAGE: required('--reviewer-image'),
        FACTORY_CODEX_REVIEW_MODEL: 'gpt-test',
        FACTORY_CODEX_REVIEW_EFFORT: 'high',
      })
    ).stdout,
  ) as StoredReviewResult
  assert.ok(
    result.paths.ledger,
    'installed review must execute from its read-only bundle snapshot and accept submitted choices',
  )
  const ledgerText = await readFile(join(repository, '.factory', result.paths.ledger), 'utf8')
  assert.ok(
    !ledgerText.includes(secret) && !ledgerText.includes(token),
    'accepted model output leaked seeded secrets',
  )
  const ledger = JSON.parse(ledgerText) as ReviewLedger
  assert.deepEqual(ledger.entries.map(entry => entry.verdict).sort(), [
    'needs-user',
    'sound',
    'unsound',
  ])
  await writeFile(
    join(scratch, 'report.json'),
    JSON.stringify(
      {
        status: 'passed',
        release: {
          version: release.version,
          manifestSha256: manifestHash,
          executableSha256: createHash('sha256').update(release.executable).digest('hex'),
        },
        authority:
          'Native installed CLI; synthetic provider submissions through real isolated MCP/repository owners; no Bun on consumer PATH',
        checks: [
          'both-provider-installed-capture',
          'readonly-bundle-snapshot',
          'accepted-model-text-redaction',
          'three-typed-verdicts',
        ],
        ledger,
      },
      null,
      2,
    ),
  )
}
