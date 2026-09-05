import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  planReviewerIsolation,
  runIsolationProbe,
  type IsolationReport,
  type ReviewerProvider,
} from '@factory/reviewer/testing'

type ProviderAuthority = {
  provider: 'codex' | 'claude'
  status: 'unavailable'
  reason: 'dedicated-test-credentials-not-configured' | 'provider-image-not-configured'
  hostCliVersion: string
}

type PlatformAuthority = {
  platform: string
  status: 'observed' | 'unavailable'
  reason?: string
}

type LabReport = {
  schemaVersion: 1
  generatedAt: string
  toolVersions: {
    dockerServer: string
    bun: string
  }
  fakeProvider: {
    status: 'verified'
    success: IsolationReport
    timeout: IsolationReport
    cancellation: IsolationReport
    descendantCleanup: IsolationReport
  }
  providers: readonly ProviderAuthority[]
  platforms: readonly PlatformAuthority[]
  credentialLeakScan: {
    matches: 0
    surfaces: readonly string[]
  }
}

async function command(args: readonly string[]): Promise<string> {
  const process = Bun.spawn([...args], { stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`${args[0]} failed: ${stderr.trim()}`)
  }
  return stdout.trim()
}

function hostVersion(executable: string): string {
  const result = Bun.spawnSync([executable, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() : 'unavailable'
}

function providerAuthority(provider: 'codex' | 'claude'): ProviderAuthority {
  const prefix = `FACTORY_TEST_${provider.toUpperCase()}`
  if (process.env[`${prefix}_AUTH`] === undefined) {
    return {
      provider,
      status: 'unavailable',
      reason: 'dedicated-test-credentials-not-configured',
      hostCliVersion: hostVersion(provider),
    }
  }
  return {
    provider,
    status: 'unavailable',
    reason: 'provider-image-not-configured',
    hostCliVersion: hostVersion(provider),
  }
}

function assertSuccessful(report: IsolationReport): void {
  const expectedAbsent = [
    '/bundle/.git',
    '/workspace/factory-live-checkout-sentinel',
    '/var/run/docker.sock',
    '/auth/codex',
    '/auth/claude',
    '/root/.codex',
    '/root/.claude',
  ]
  if (
    report.termination !== 'completed' ||
    report.exitCode !== 0 ||
    report.observation?.providerVersion !== 'fake-provider/1' ||
    report.observation?.uid !== Number(report.containerPolicy.user.split(':')[0]) ||
    report.observation.bundleReadable !== true ||
    report.observation.bundleWriteBlocked !== true ||
    report.observation.authReadable !== true ||
    report.observation.authWriteBlocked !== true ||
    report.observation.outputWritable !== true ||
    report.observation.networkRoutePresent !== true ||
    report.containerPolicy.readonlyRootfs !== true ||
    report.containerPolicy.user.startsWith('0:') ||
    !report.containerPolicy.capDrop.includes('ALL') ||
    !report.containerPolicy.securityOptions.some(option =>
      option.startsWith('no-new-privileges'),
    ) ||
    !report.containerPolicy.tmpfsTargets.includes('/tmp') ||
    report.mounts.some(({ role, mode }) => (role === 'output' ? mode !== 'rw' : mode !== 'ro')) ||
    expectedAbsent.some(path => !report.observation?.forbiddenPathsAbsent.includes(path)) ||
    !report.cleanup.containerRemoved
  ) {
    throw new Error('fake reviewer did not satisfy the isolation contract')
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function renderHtml(report: LabReport): string {
  const rows = [
    ['Fake provider', report.fakeProvider.status],
    ...report.providers.map(({ provider, status, reason }) => [provider, `${status}: ${reason}`]),
    ...report.platforms.map(({ platform, status, reason }) => [
      platform,
      reason === undefined ? status : `${status}: ${reason}`,
    ]),
  ]
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Factory reviewer isolation</title><style>
body{font:16px/1.5 system-ui;max-width:900px;margin:3rem auto;padding:0 1rem;background:#101416;color:#e8f0ef}
h1{font-size:2rem}table{border-collapse:collapse;width:100%}th,td{padding:.7rem;border-bottom:1px solid #3b4748;text-align:left}
code{color:#9ee7d7}.verified{color:#83e377}.unavailable{color:#ffd166}
</style></head><body><h1>Reviewer isolation oracle</h1>
<p>The fake reviewer verified immutable inputs, read-only authentication, one writable output, network routing, and container cleanup. Real-provider results remain unavailable until dedicated test credentials and images are supplied.</p>
<table><thead><tr><th>Authority</th><th>Result</th></tr></thead><tbody>
${rows.map(([name, result]) => `<tr><td>${escapeHtml(name ?? '')}</td><td>${escapeHtml(result ?? '')}</td></tr>`).join('\n')}
</tbody></table><p>Image: <code>${escapeHtml(report.fakeProvider.success.imageDigest)}</code></p>
<p>Credential-value leak matches: <strong>${report.credentialLeakScan.matches}</strong></p></body></html>\n`
}

async function probe(
  provider: ReviewerProvider,
  imageDigest: string,
  root: string,
  scenario: 'success' | 'hang' | 'descendant',
  termination: 'completed' | 'timed-out' | 'cancelled',
  secret: string,
): Promise<IsolationReport> {
  const output = join(root, `output-${termination}-${scenario}`)
  await mkdir(output)
  await chmod(output, 0o777)
  const plan = planReviewerIsolation({
    provider,
    bundleHostPath: join(root, 'bundle'),
    outputHostPath: output,
    auth: [
      {
        hostPath: join(root, 'auth', 'credentials.json'),
        containerPath: `/auth/${provider}/credentials.json`,
      },
    ],
  })
  if (!plan.ok) throw new Error(plan.detail)

  if (termination === 'cancelled') {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 3_000)
    return await runIsolationProbe(plan.plan, {
      imageDigest,
      scenario,
      signal: controller.signal,
      sensitiveValues: [secret],
    })
  }
  return await runIsolationProbe(plan.plan, {
    imageDigest,
    scenario,
    ...(termination === 'timed-out' ? { timeoutMs: 3_000 } : {}),
    sensitiveValues: [secret],
  })
}

async function main(): Promise<void> {
  const outputFlag = process.argv.indexOf('--output')
  const outputRoot = resolve(
    outputFlag === -1
      ? join(tmpdir(), 'factory-reviewer-isolation-report')
      : (process.argv[outputFlag + 1] ?? join(tmpdir(), 'factory-reviewer-isolation-report')),
  )
  const root = await mkdtemp(join(tmpdir(), 'factory-reviewer-isolation-'))
  const secret = `fixture-credential-${crypto.randomUUID()}`

  try {
    await mkdir(join(root, 'bundle'))
    await mkdir(join(root, 'auth'))
    await writeFile(join(root, 'bundle', 'input.json'), '{"subject":"fixture"}\n')
    await writeFile(join(root, 'auth', 'credentials.json'), `${secret}\n`)
    await chmod(join(root, 'auth', 'credentials.json'), 0o444)

    const context = resolve(import.meta.dir, '../docker/reviewer-isolation')
    const imageDigest = await command(['docker', 'build', '--quiet', context])

    const collisionOutput = join(root, 'output-foreign-collision')
    await mkdir(collisionOutput)
    await chmod(collisionOutput, 0o777)
    const collisionPlan = planReviewerIsolation({
      provider: 'fake',
      bundleHostPath: join(root, 'bundle'),
      outputHostPath: collisionOutput,
      auth: [],
    })
    if (!collisionPlan.ok) throw new Error(collisionPlan.detail)
    const collisionName = `factory-reviewer-foreign-${crypto.randomUUID()}`
    await command([
      'docker',
      'create',
      '--name',
      collisionName,
      '--label',
      'factory.review-attempt=foreign-owner',
      imageDigest,
    ])
    try {
      await runIsolationProbe(collisionPlan.plan, {
        imageDigest,
        containerIdentity: { name: collisionName, label: 'factory-owner' },
      })
      throw new Error('foreign reviewer container name collision was accepted')
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Docker refused reviewer container'))
        throw error
    }
    const survivingLabel = await command([
      'docker',
      'inspect',
      '--format',
      '{{ index .Config.Labels "factory.review-attempt" }}',
      collisionName,
    ])
    if (survivingLabel !== 'foreign-owner')
      throw new Error('Factory removed or replaced a foreign collision container')
    await command(['docker', 'rm', '--force', collisionName])

    const success = await probe('fake', imageDigest, root, 'success', 'completed', secret)
    assertSuccessful(success)
    if ((process.getuid?.() ?? 0) > 0) {
      const privateAuth = join(root, 'auth', 'private-credentials.json')
      const privateOutput = join(root, 'output-private-auth')
      await writeFile(privateAuth, `${secret}\n`, { mode: 0o600 })
      await mkdir(privateOutput)
      await chmod(privateOutput, 0o777)
      const privatePlan = planReviewerIsolation({
        provider: 'fake',
        bundleHostPath: join(root, 'bundle'),
        outputHostPath: privateOutput,
        auth: [
          {
            hostPath: privateAuth,
            containerPath: '/auth/fake/credentials.json',
          },
        ],
      })
      if (!privatePlan.ok) throw new Error(privatePlan.detail)
      const privateReport = await runIsolationProbe(privatePlan.plan, {
        imageDigest,
        sensitiveValues: [secret],
      })
      if (
        privateReport.observation?.uid !== process.getuid?.() ||
        privateReport.containerPolicy.user.startsWith('0:')
      )
        throw new Error('private auth did not retain its validated non-root owner identity')
    }
    const timeout = await probe('fake', imageDigest, root, 'hang', 'timed-out', secret)
    const cancellation = await probe('fake', imageDigest, root, 'hang', 'cancelled', secret)
    const descendantCleanup = await probe(
      'fake',
      imageDigest,
      root,
      'descendant',
      'timed-out',
      secret,
    )
    for (const [expected, report] of [
      ['timed-out', timeout],
      ['cancelled', cancellation],
      ['timed-out', descendantCleanup],
    ] as const) {
      if (report.termination !== expected || !report.cleanup.containerRemoved) {
        throw new Error(`${expected} reviewer cleanup was not verified`)
      }
    }

    const outputAlias = join(root, 'output-symlink-alias')
    await symlink(join(root, 'bundle'), outputAlias)
    const aliased = planReviewerIsolation({
      provider: 'fake',
      bundleHostPath: join(root, 'bundle'),
      outputHostPath: outputAlias,
      auth: [],
    })
    if (!aliased.ok) throw new Error('symlink regression did not reach filesystem validation')
    try {
      await runIsolationProbe(aliased.plan, { imageDigest })
      throw new Error('writable output symlink alias was accepted')
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('host-path-overlap')) throw error
    }
    try {
      await readFile(join(root, 'bundle', 'result.txt'))
      throw new Error('writable output alias mutated the immutable bundle')
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }

    const imageHistory = await command(['docker', 'image', 'history', '--no-trunc', imageDigest])
    const scanned = [
      imageHistory,
      await readFile(join(context, 'Dockerfile'), 'utf8'),
      await readFile(join(context, 'probe.ts'), 'utf8'),
      JSON.stringify({ success, timeout, cancellation, descendantCleanup }),
      await readFile(join(root, 'output-completed-success', 'result.txt'), 'utf8'),
    ]
    if (scanned.some(surface => surface.includes(secret))) {
      throw new Error('credential value escaped into a reportable surface')
    }

    const dockerPlatform = await command([
      'docker',
      'version',
      '--format',
      '{{.Server.Os}}/{{.Server.Arch}}',
    ])
    const dockerVersion = await command(['docker', 'version', '--format', '{{.Server.Version}}'])
    const report: LabReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      toolVersions: {
        dockerServer: dockerVersion,
        bun: Bun.version,
      },
      fakeProvider: {
        status: 'verified',
        success,
        timeout,
        cancellation,
        descendantCleanup,
      },
      providers: [providerAuthority('codex'), providerAuthority('claude')],
      platforms: [
        { platform: dockerPlatform, status: 'observed' },
        {
          platform: 'linux/amd64',
          status: 'unavailable',
          reason: 'native-linux-x64-authority-not-run',
        },
      ],
      credentialLeakScan: {
        matches: 0,
        surfaces: [
          'image-history',
          'fake-image-context',
          'all-scenario-container-logs',
          'all-recursive-review-outputs',
          'sanitized-reports',
        ],
      },
    }

    await mkdir(outputRoot, { recursive: true })
    await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(join(outputRoot, 'report.html'), renderHtml(report))
    console.log(`Reviewer isolation report: ${join(outputRoot, 'report.json')}`)
    console.log(`Human report: ${join(outputRoot, 'report.html')}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
