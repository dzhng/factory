import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'

import type { MountPlan, ReviewerProvider } from './index'

export type ProbeTermination = 'completed' | 'timed-out' | 'cancelled'

export type ContainerObservation = {
  providerVersion: string
  uid: number
  bundleReadable: boolean
  bundleWriteBlocked: boolean
  authReadable: boolean
  authWriteBlocked: boolean
  outputWritable: boolean
  forbiddenPathsAbsent: readonly string[]
  networkRoutePresent: boolean
}

export type IsolationReport = {
  schemaVersion: 1
  provider: ReviewerProvider
  imageDigest: string
  networkMode: 'bridge'
  mounts: readonly {
    role: 'bundle' | 'output' | 'auth'
    containerPath: string
    mode: 'ro' | 'rw'
  }[]
  containerPolicy: {
    readonlyRootfs: boolean
    user: string
    capDrop: readonly string[]
    securityOptions: readonly string[]
    tmpfsTargets: readonly string[]
  }
  termination: ProbeTermination
  exitCode: number | null
  observation?: ContainerObservation
  outputHashes: Readonly<Record<string, string>>
  cleanup: { containerRemoved: boolean }
}

export type IsolationProbeOptions = {
  imageDigest: string
  scenario?: 'success' | 'hang' | 'descendant'
  timeoutMs?: number
  signal?: AbortSignal
}

type CommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  termination: ProbeTermination
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let termination: ProbeTermination = 'completed'
    let settled = false

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))

    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolve({ exitCode, stdout, stderr, termination })
    }
    const stop = (reason: Exclude<ProbeTermination, 'completed'>) => {
      if (settled) return
      termination = reason
      child.kill('SIGTERM')
    }
    const abort = () => stop('cancelled')
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => stop('timed-out'), options.timeoutMs)

    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', reject)
    child.on('close', finish)
  })
}

async function hashOutputs(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue
    const bytes = await readFile(`${root}/${entry.name}`)
    hashes[entry.name] = createHash('sha256').update(bytes).digest('hex')
  }
  return hashes
}

function dockerMount(hostPath: string, containerPath: string, readonly: boolean) {
  return `type=bind,src=${hostPath},dst=${containerPath}${readonly ? ',readonly' : ''}`
}

export async function runIsolationProbe(
  plan: MountPlan,
  options: IsolationProbeOptions,
): Promise<IsolationReport> {
  const [bundle, output, ...auth] = await Promise.all([
    stat(plan.bundle.hostPath),
    stat(plan.output.hostPath),
    ...plan.auth.map(({ hostPath }) => stat(hostPath)),
  ])
  if (!bundle.isDirectory() || !output.isDirectory() || auth.some(entry => !entry.isFile())) {
    throw new Error('Reviewer mounts require bundle/output directories and auth files')
  }
  const containerName = `factory-isolation-${randomUUID()}`
  const dockerArgs = [
    'run',
    '--detach',
    '--name',
    containerName,
    '--network',
    'bridge',
    '--read-only',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount',
    dockerMount(plan.bundle.hostPath, plan.bundle.containerPath, true),
    '--mount',
    dockerMount(plan.output.hostPath, plan.output.containerPath, false),
  ]
  for (const auth of plan.auth) {
    dockerArgs.push('--mount', dockerMount(auth.hostPath, auth.containerPath, true))
  }
  dockerArgs.push(options.imageDigest, options.scenario ?? 'success', plan.provider)

  let result: CommandResult | undefined
  let observation: ContainerObservation | undefined
  let inspectedMounts: IsolationReport['mounts'] = []
  let containerPolicy: IsolationReport['containerPolicy'] | undefined
  try {
    const started = await runCommand('docker', dockerArgs)
    if (started.exitCode !== 0) {
      throw new Error(`Docker refused reviewer container: ${started.stderr.trim()}`)
    }
    const inspected = await runCommand('docker', ['inspect', containerName])
    if (inspected.exitCode !== 0) {
      throw new Error('Docker could not inspect the reviewer container')
    }
    const [container] = JSON.parse(inspected.stdout) as [
      {
        Config: { User: string }
        HostConfig: {
          ReadonlyRootfs: boolean
          CapDrop: string[] | null
          SecurityOpt: string[] | null
          Tmpfs: Record<string, string> | null
        }
        Mounts: { Destination: string; RW: boolean }[]
      },
    ]
    if (container === undefined) {
      throw new Error('Docker returned no reviewer container inspection')
    }
    inspectedMounts = container.Mounts.map(
      ({ Destination, RW }): IsolationReport['mounts'][number] => ({
        role: Destination === '/bundle' ? 'bundle' : Destination === '/out' ? 'output' : 'auth',
        containerPath: Destination,
        mode: RW ? 'rw' : 'ro',
      }),
    ).sort((left, right) => left.containerPath.localeCompare(right.containerPath))
    const expectedTargets = [
      '/bundle',
      '/out',
      ...plan.auth.map(({ containerPath }) => containerPath),
    ].sort()
    if (
      inspectedMounts.map(({ containerPath }) => containerPath).join('\n') !==
      expectedTargets.join('\n')
    ) {
      throw new Error('Docker reviewer container received an unexpected mount')
    }
    containerPolicy = {
      readonlyRootfs: container.HostConfig.ReadonlyRootfs,
      user: container.Config.User,
      capDrop: container.HostConfig.CapDrop ?? [],
      securityOptions: container.HostConfig.SecurityOpt ?? [],
      tmpfsTargets: Object.keys(container.HostConfig.Tmpfs ?? {}).sort(),
    }
    const waited = await runCommand('docker', ['wait', containerName], {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    })
    const containerExitCode =
      waited.termination === 'completed' ? Number.parseInt(waited.stdout.trim(), 10) : null
    result = { ...waited, exitCode: containerExitCode }
    if (result.termination === 'completed' && result.exitCode === 0) {
      const logs = await runCommand('docker', ['logs', containerName])
      observation = JSON.parse(logs.stdout) as ContainerObservation
    }
  } finally {
    await runCommand('docker', ['rm', '--force', containerName])
  }

  if (result === undefined) throw new Error('Docker probe did not start')
  if (containerPolicy === undefined) {
    throw new Error('Docker probe policy was not observed')
  }
  const inspect = await runCommand('docker', ['inspect', containerName])

  return {
    schemaVersion: 1,
    provider: plan.provider,
    imageDigest: options.imageDigest,
    networkMode: 'bridge',
    mounts: inspectedMounts,
    containerPolicy,
    termination: result.termination,
    exitCode: result.exitCode,
    ...(observation === undefined ? {} : { observation }),
    outputHashes: await hashOutputs(plan.output.hostPath),
    cleanup: { containerRemoved: inspect.exitCode !== 0 },
  }
}
