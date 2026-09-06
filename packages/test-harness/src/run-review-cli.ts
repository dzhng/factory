import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { canonicalJson } from '@factory/contract'

const cliPackageRoot = resolve(import.meta.dir, '../../cli')
const factoryProgram = join(cliPackageRoot, 'dist/factory.js')

async function command(args: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${args[0]} failed: ${stderr.trim()}`)
  return stdout.trim()
}

function startFactory(args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv) {
  return Bun.spawn([process.execPath, factoryProgram, ...args], {
    cwd,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function finishFactory(
  child: ReturnType<typeof startFactory>,
): Promise<{ code: number; output: string }> {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, output: `${stdout}${stderr}` }
}

async function factory(
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  return await finishFactory(startFactory(args, cwd, environment))
}

async function observationCount(root: string): Promise<number> {
  return await Array.fromAsync(
    new Bun.Glob('repository-observations/*.json').scan({ cwd: join(root, '.factory') }),
  ).then(paths => paths.length)
}

async function main() {
  await command(['bun', 'run', 'build'], cliPackageRoot)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-review-cli-')))
  try {
    await command(['git', 'init', '-q', '-b', 'main'], root)
    const asset = resolve(
      import.meta.dir,
      '../../../specs/done/factory-v1/assets/review-plan/complete-bundle',
    )
    await cp(join(asset, '.factory'), join(root, '.factory'), { recursive: true })
    await writeFile(
      join(root, '.factory', 'manifest.json'),
      canonicalJson({
        schemaVersion: 1,
        format: 'factory-repository',
        minimumReaderVersion: '0.1.0',
        repositoryId: 'repo_review_lab',
        createdAt: '2026-09-05T00:00:00Z',
      }),
    )
    await writeFile(
      join(root, '.factory', 'config.json'),
      canonicalJson({ schemaVersion: 1, reviewer: 'auto' }),
    )
    const authRoot = join(root, 'dedicated-auth')
    await mkdir(authRoot)
    const auth = join(authRoot, 'auth.json')
    await writeFile(auth, 'factory-test-unsound factory-test-delay\n', { mode: 0o444 })
    await chmod(auth, 0o444)
    const image =
      process.env.FACTORY_REVIEWER_IMAGE ??
      (await command(
        [
          'docker',
          'build',
          '-q',
          '--file',
          resolve(import.meta.dir, '../docker/reviewer-isolation/Dockerfile'),
          resolve(import.meta.dir, '../../..'),
        ],
        root,
      ))
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      FACTORY_CODEX_REVIEW_MODEL: 'gpt-test',
      FACTORY_CODEX_REVIEW_EFFORT: 'high',
      FACTORY_CLAUDE_REVIEW_MODEL: 'claude-test',
      FACTORY_CLAUDE_REVIEW_EFFORT: 'high',
      FACTORY_CODEX_AUTH_FILE: auth,
      FACTORY_CLAUDE_AUTH_FILE: join(authRoot, 'not-authenticated.json'),
      FACTORY_REVIEWER_IMAGE: image,
      XDG_CACHE_HOME: join(root, 'update-cache'),
    }
    for (const invalid of [
      ['review', '--pr', '42x'],
      ['review', '--pr', '9007199254740993'],
      ['review', '--full', '--force'],
      ['review', '--fail-on', 'urgent'],
    ]) {
      const result = await factory(invalid, root, environment)
      if (result.code !== 1 || result.output.length === 0)
        throw new Error(`factory review accepted invalid flags: ${invalid.join(' ')}`)
    }
    environment.XDG_CONFIG_HOME = join(root, 'global-config')
    await factory(
      ['configure', '--global', '--docker-memory-mib', '384', '--docker-cpus', '3'],
      root,
      environment,
    )
    await factory(
      ['configure', '--repo', '--docker-cpus', '2', '--docker-pids', '64'],
      root,
      environment,
    )
    const pendingFirst = Promise.all([
      factory(
        ['review', '--session', 'session-review-lab', '--docker-cpus', '1'],
        root,
        environment,
      ),
      factory(
        ['review', '--session', 'session-review-lab', '--docker-cpus', '1'],
        root,
        environment,
      ),
    ])
    const deadline = Date.now() + 10_000
    let observed = false
    while (!observed && Date.now() < deadline) {
      const containers = await command(
        ['docker', 'ps', '-q', '--filter', 'label=factory.review-attempt'],
        root,
      )
      for (const id of containers.split('\n').filter(Boolean)) {
        const [container] = JSON.parse(await command(['docker', 'inspect', id], root)) as {
          Mounts: { Source: string }[]
          HostConfig: { Memory: number; NanoCpus: number; PidsLimit: number }
        }[]
        if (!container?.Mounts.some(mount => mount.Source.startsWith(`${root}/`))) continue
        if (
          container.HostConfig.Memory !== 384 * 1024 * 1024 ||
          container.HostConfig.NanoCpus !== 1_000_000_000 ||
          container.HostConfig.PidsLimit !== 64
        )
          throw new Error(
            'CLI did not apply global, repository, and flag resource preferences to Docker',
          )
        observed = true
      }
      if (!observed) await Bun.sleep(25)
    }
    const first = await pendingFirst
    if (!observed) throw new Error('CLI resource policy was not observed on an executing reviewer')
    if (first.some(({ code }) => code !== 0))
      throw new Error(
        `concurrent factory review failed: ${first.map(({ output }) => output).join('')}`,
      )
    const firstResults = first.map(({ output }) => JSON.parse(output) as Record<string, string>)
    const accepted = firstResults.find(result => result.disposition === 'complete')
    const noOp = firstResults.find(result => result.status === 'already-reviewed')
    if (accepted === undefined || noOp === undefined)
      throw new Error(`concurrent review did not converge: ${JSON.stringify(firstResults)}`)
    const { FACTORY_REVIEWER_IMAGE: _imageDigest, ...noImageEnvironment } = environment
    const second = await factory(['review', '--fail-on', 'unsound'], root, noImageEnvironment)
    const retried = JSON.parse(second.output) as Record<string, string>
    if (
      second.code !== 1 ||
      retried.status !== 'already-reviewed' ||
      retried.reviewId !== accepted.reviewId
    )
      throw new Error(
        `factory review retry did not enforce its exact prior ledger: ${second.output}`,
      )

    const timed = await factory(
      ['review', '--force', '--review-timeout-seconds', '1'],
      root,
      environment,
    )
    const timedReview = JSON.parse(timed.output) as {
      disposition: string
      paths: { manifest: string }
    }
    const timedManifest = JSON.parse(
      await readFile(join(root, '.factory', timedReview.paths.manifest), 'utf8'),
    ) as { failureReason?: string }
    if (
      timed.code !== 1 ||
      timedReview.disposition !== 'failed' ||
      timedManifest.failureReason !== 'reviewer-timeout'
    )
      throw new Error(`Configured review deadline was not enforced: ${timed.output}`)

    const beforeWaiter = await observationCount(root)
    const lockHolder = startFactory(['review', '--force'], root, environment)
    const observationDeadline = Date.now() + 10_000
    while ((await observationCount(root)) === beforeWaiter) {
      if (Date.now() >= observationDeadline)
        throw new Error('first review did not acquire the subject lock')
      await Bun.sleep(25)
    }
    const waiter = startFactory(['review', '--force'], root, environment)
    await Bun.sleep(100)
    await writeFile(
      join(root, '.factory', 'config.json'),
      canonicalJson({
        schemaVersion: 1,
        reviewer: { provider: 'claude', model: 'claude-new', effort: 'high' },
      }),
    )
    const [holderResult, waiterResult] = await Promise.all([
      finishFactory(lockHolder),
      finishFactory(waiter),
    ])
    const waiterReview = JSON.parse(waiterResult.output) as {
      disposition: string
      reviewer: { provider: string; model: string }
    }
    if (
      holderResult.code !== 0 ||
      waiterResult.code !== 1 ||
      waiterReview.disposition !== 'failed' ||
      waiterReview.reviewer.provider !== 'claude' ||
      waiterReview.reviewer.model !== 'claude-new'
    )
      throw new Error(`subject-lock waiter used stale repository policy: ${waiterResult.output}`)

    const claudeAuth = join(authRoot, 'claude.json')
    await writeFile(claudeAuth, 'factory-test-prefix-nonzero\n', { mode: 0o444 })
    const partialEnvironment = { ...environment, FACTORY_CLAUDE_AUTH_FILE: claudeAuth }
    const partial = await factory(['review', '--force'], root, partialEnvironment)
    const partialReview = JSON.parse(partial.output) as { reviewId: string; disposition: string }
    if (partial.code !== 1 || partialReview.disposition !== 'partial')
      throw new Error(
        `factory review did not produce the partial acceptance fixture: ${partial.output}`,
      )
    const attempts = join(root, '.git', 'factory-runtime', 'review-attempts-v1')
    await rename(attempts, `${attempts}-saved`)
    const poison = join(root, 'unsafe-attempt-runtime')
    await mkdir(poison)
    await symlink(poison, attempts)
    const acceptedPartial = await factory(
      ['review', '--accept-partial', partialReview.reviewId],
      root,
      noImageEnvironment,
    )
    if (
      acceptedPartial.code !== 0 ||
      (JSON.parse(acceptedPartial.output) as { status?: string }).status !== 'accepted-partial'
    )
      throw new Error(
        `portable partial acceptance depended on runtime recovery: ${acceptedPartial.output}`,
      )
    process.stdout.write(
      canonicalJson({ schemaVersion: 1, first: accepted.disposition, retry: 'already-reviewed' }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
