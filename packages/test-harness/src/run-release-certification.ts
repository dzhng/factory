import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { verifyReleaseArtifact, type ReleaseTarget } from '@factory/cli'

type CommandResult = { code: number; stdout: string; stderr: string }
type Journey = { name: string; status: 'passed'; detail: string }

const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000
const COMMAND_OUTPUT_LIMIT = 8 * 1024 * 1024

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function required(name: string): string {
  const value = option(name)
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return resolve(value)
}

async function command(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: environment,
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const readBounded = async (stream: ReadableStream<Uint8Array>, name: string) => {
    let size = 0
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) {
      size += chunk.byteLength
      if (size > COMMAND_OUTPUT_LIMIT) throw new Error(`${name} exceeded its output bound`)
      chunks.push(chunk.slice())
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [code, stdout, stderr] = await Promise.race([
      Promise.all([
        child.exited,
        readBounded(child.stdout, 'stdout'),
        readBounded(child.stderr, 'stderr'),
      ]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('certification command timed out')),
          COMMAND_TIMEOUT_MS,
        )
      }),
    ])
    return { code, stdout, stderr }
  } catch (error) {
    child.kill(9)
    await child.exited.catch(() => undefined)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function succeed(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<CommandResult> {
  const result = await command(executable, args, cwd, environment, stdin)
  if (result.code !== 0)
    throw new Error(`${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result
}

async function replayProvider(
  provider: 'codex' | 'claude',
  executable: string,
  repository: string,
  home: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const harnessRoot = resolve(import.meta.dir, '..')
  const fixtureRoot = join(harnessRoot, 'fixtures', 'providers', provider)
  const transcript = join(
    home,
    provider === 'codex'
      ? '.codex/sessions/certification.jsonl'
      : '.claude/projects/certification.jsonl',
  )
  await mkdir(dirname(transcript), { recursive: true })
  await cp(join(fixtureRoot, 'transcript.jsonl'), transcript)
  const rows = (await readFile(join(fixtureRoot, 'hooks.jsonl'), 'utf8'))
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const config = JSON.parse(
    await readFile(
      provider === 'codex'
        ? join(home, '.codex', 'hooks.json')
        : join(home, '.claude', 'settings.json'),
      'utf8',
    ),
  )
  for (const row of rows.filter(value =>
    [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ].includes(String(value.hook_event_name)),
  )) {
    row.cwd = repository
    if (row.transcript_path !== undefined) row.transcript_path = transcript
    if (row.last_assistant_message !== undefined)
      row.last_assistant_message = 'Stale transcript answer.'
    const hook = config.hooks[String(row.hook_event_name)].at(-1).hooks[0]
    const result =
      provider === 'codex'
        ? await command(
            '/bin/sh',
            ['-c', hook.command],
            repository,
            environment,
            `${JSON.stringify(row)}\n`,
          )
        : await command(
            hook.command,
            hook.args,
            repository,
            environment,
            `${JSON.stringify(row)}\n`,
          )
    if (result.code !== 0 || result.stdout !== '{}\n')
      throw new Error(`${provider} installed hook failed through ${executable}`)
  }
}

async function openAndConfirmDecision(
  executable: string,
  repository: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const child = Bun.spawn([executable, 'open'], {
    cwd: repository,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  try {
    let output = ''
    let origin: string | undefined
    const deadline = Date.now() + 10_000
    while (origin === undefined && Date.now() < deadline) {
      const remaining = deadline - Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('factory open startup timed out')), remaining)
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      if (next.done) break
      output += new TextDecoder().decode(next.value)
      if (Buffer.byteLength(output) > 64 * 1024)
        throw new Error('factory open startup output exceeded its bound')
      origin = output.split('\n').find(line => /^http:\/\/127\.0\.0\.1:\d+$/.test(line))
    }
    if (origin === undefined) throw new Error('factory open did not publish its loopback origin')
    const signal = AbortSignal.timeout(5_000)
    const snapshot = (await (await fetch(`${origin}/api/snapshot`, { signal })).json()) as {
      state: string
      decisions: {
        stateFingerprint: string
        lineages: {
          observations: { humanStatus: string; observation: { observationId: string } }[]
        }[]
      }
    }
    if (snapshot.state !== 'ready')
      throw new Error('factory open did not render a ready projection')
    const decision = snapshot.decisions.lineages
      .flatMap(lineage => lineage.observations)
      .find(observation => observation.humanStatus === 'unconfirmed')
    if (decision === undefined) throw new Error('review decision was not visible in factory open')
    const session = (await (await fetch(`${origin}/api/session`, { signal })).json()) as {
      csrfToken: string
    }
    const response = await fetch(`${origin}/api/actions/decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Factory-CSRF': session.csrfToken,
      },
      body: JSON.stringify({
        actionId: 'action_00000000000000000000000031',
        kind: 'confirm',
        targetObservationId: decision.observation.observationId,
        expectedStateFingerprint: snapshot.decisions.stateFingerprint,
      }),
      signal,
    })
    if (response.status !== 201) throw new Error('factory open rejected the decision action')
  } finally {
    child.kill()
    await child.exited.catch(() => undefined)
    reader.releaseLock()
  }
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

const archivePath = required('--archive')
const manifestPath = required('--manifest')
const expectedManifestSha256 = option('--manifest-sha256')
if (expectedManifestSha256 === undefined) throw new Error('--manifest-sha256 is required')
const reportRoot = resolve(option('--output') ?? join(tmpdir(), 'factory-release-certification'))
const archive = await readFile(archivePath)
const adjacentManifest = await readFile(manifestPath)
const adjacent = JSON.parse(adjacentManifest.toString()) as {
  release: { target: ReleaseTarget }
}
const release = await verifyReleaseArtifact({
  archive,
  adjacentManifest,
  expectedManifestSha256,
  expectedTarget: adjacent.release.target,
})
// macOS exposes its temporary directory through /var while realpath resolves provider homes
// through /private/var. Canonicalize once so hook payload paths share the confinement root.
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'factory-release-')))
const journeys: Journey[] = []

try {
  const home = join(scratch, 'home')
  const repository = join(scratch, 'repository')
  const bin = join(scratch, 'bin')
  const executable = join(bin, 'factory')
  await Promise.all([
    mkdir(join(home, '.codex'), { recursive: true }),
    mkdir(join(home, '.claude'), { recursive: true }),
    mkdir(repository),
    mkdir(bin),
  ])
  await writeFile(executable, release.executable, { mode: 0o755 })
  await chmod(executable, 0o755)
  for (const launcher of ['open', 'xdg-open']) {
    const path = join(bin, launcher)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
  }
  const docker = (
    await succeed('sh', ['-c', 'command -v docker'], scratch, process.env)
  ).stdout.trim()
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.state'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PATH: `${bin}:${dirname(docker)}:/usr/bin:/bin`,
  }
  await succeed('git', ['init', '-b', 'main'], repository, environment)
  await succeed('git', ['config', 'user.email', 'factory@example.invalid'], repository, environment)
  await succeed('git', ['config', 'user.name', 'Factory Certification'], repository, environment)
  await writeFile(join(repository, 'app.ts'), 'export const certified = true\n')
  await succeed('git', ['add', 'app.ts'], repository, environment)
  await succeed('git', ['commit', '-m', 'certification fixture'], repository, environment)
  await succeed(executable, ['--version'], repository, environment)
  await succeed(executable, ['init', '--canonical-branch', 'main'], repository, environment)
  await succeed('git', ['add', '.factory'], repository, environment)
  await succeed('git', ['commit', '-m', 'initialize Factory'], repository, environment)
  const factoryHead = (await succeed('git', ['rev-parse', 'HEAD'], repository, environment)).stdout
  await succeed(executable, ['install', '--executable', executable], repository, environment)
  journeys.push({ name: 'install', status: 'passed', detail: 'both provider hooks reconciled' })

  await replayProvider('codex', executable, repository, home, environment)
  await replayProvider('claude', executable, repository, home, environment)
  journeys.push({
    name: 'capture',
    status: 'passed',
    detail: 'both native provider fixtures stored',
  })

  const auth = join(scratch, 'review-auth.json')
  await writeFile(auth, 'factory-test-decision\n', { mode: 0o444 })
  await chmod(auth, 0o444)
  const image = (
    await succeed(
      'docker',
      ['build', '-q', resolve(import.meta.dir, '../docker/reviewer-isolation')],
      scratch,
      process.env,
    )
  ).stdout.trim()
  const reviewEnvironment = {
    ...environment,
    FACTORY_CODEX_AUTH_FILE: auth,
    FACTORY_REVIEWER_IMAGE_DIGEST: image,
    FACTORY_CODEX_REVIEW_MODEL: 'gpt-test',
    FACTORY_CODEX_REVIEW_EFFORT: 'high',
  }
  const review = await succeed(executable, ['review'], repository, reviewEnvironment)
  const reviewResult = JSON.parse(review.stdout) as { disposition: string }
  if (reviewResult.disposition !== 'complete')
    throw new Error(`review was not complete: ${review.stdout.trim()}`)
  journeys.push({
    name: 'review',
    status: 'passed',
    detail: 'isolated deterministic review accepted',
  })

  await openAndConfirmDecision(executable, repository, reviewEnvironment)
  journeys.push({
    name: 'ui-action',
    status: 'passed',
    detail: 'loopback projection confirmed a decision',
  })

  const doctor = JSON.parse(
    (await succeed(executable, ['doctor'], repository, reviewEnvironment)).stdout,
  ) as {
    repository: string
    installation: { transaction: string }
    projection: { sessions: unknown[] }
    providers: Record<
      'codex' | 'claude',
      | { availability: 'available'; version: string }
      | { availability: 'unavailable'; reason: string }
    >
  }
  if (
    doctor.repository !== 'ok' ||
    doctor.installation.transaction !== 'absent' ||
    doctor.projection.sessions.length !== 2
  )
    throw new Error('doctor did not verify the certified installation')
  journeys.push({
    name: 'diagnostics',
    status: 'passed',
    detail: 'repository and installation healthy',
  })

  await succeed(
    executable,
    [
      'upgrade',
      '--archive',
      archivePath,
      '--manifest',
      manifestPath,
      '--manifest-sha256',
      expectedManifestSha256,
    ],
    repository,
    reviewEnvironment,
  )
  journeys.push({
    name: 'upgrade',
    status: 'passed',
    detail: 'exact artifact atomically reinstalled',
  })

  await succeed(executable, ['uninstall'], repository, reviewEnvironment)
  const providerBytes = await Promise.all([
    readFile(join(home, '.codex', 'hooks.json'), 'utf8'),
    readFile(join(home, '.claude', 'settings.json'), 'utf8'),
  ])
  if (providerBytes.some(bytes => bytes.includes(executable)))
    throw new Error('uninstall retained an owned Factory hook')
  journeys.push({ name: 'uninstall', status: 'passed', detail: 'owned hooks removed exactly' })

  const finalHead = (await succeed('git', ['rev-parse', 'HEAD'], repository, environment)).stdout
  if (finalHead !== factoryHead) throw new Error('Factory changed the repository Git head')
  const report = {
    schemaVersion: 1,
    artifact: {
      version: release.version,
      revision: release.revision,
      target: release.target,
      manifestSha256: release.manifestSha256,
      archiveSha256: digest(archive),
      executableSha256: release.executableSha256,
    },
    platform: {
      os: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      bun: Bun.version,
      git: (await succeed('git', ['--version'], scratch, environment)).stdout.trim(),
      docker: (await succeed('docker', ['--version'], scratch, environment)).stdout.trim(),
    },
    providers: doctor.providers,
    authorities: {
      providerExecution: 'deterministic-isolation-fixture',
      realProviderCredentials: 'unavailable',
      githubReleaseAttestation: 'unavailable',
    },
    journeys,
  }
  await mkdir(reportRoot, { recursive: true })
  await writeFile(join(reportRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(
    join(reportRoot, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Factory release certification</title><style>body{font:16px system-ui;max-width:960px;margin:3rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.6rem;text-align:left}.passed{color:#176b35}</style><h1>Factory release certification</h1><p>Artifact <code>${html(release.executableSha256)}</code></p><table><thead><tr><th>Journey</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${journeys.map(item => `<tr><td>${html(item.name)}</td><td class="passed">${item.status}</td><td>${html(item.detail)}</td></tr>`).join('')}</tbody></table>`,
  )
  process.stdout.write(`${join(reportRoot, 'report.json')}\n${join(reportRoot, 'index.html')}\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
