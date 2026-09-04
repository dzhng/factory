import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { resolveReviewerIsolation, type MountPlan, type ReviewerProvider } from './index.js'

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
  /** Exact immutable image identity; mutable tags are refused. */
  imageDigest: string
  expectedBundleSha256?: string
  reviewer?: { model: string; effort: string; promptVersion: string }
  scenario?: 'success' | 'hang' | 'descendant' | 'review'
  timeoutMs?: number
  signal?: AbortSignal
  /** Ephemeral test-only sentinels that must not appear in logs or recursive output. */
  sensitiveValues?: readonly string[]
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
    let outputBytes = 0

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      if (settled) return
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > 1024 * 1024) {
        settled = true
        child.kill('SIGKILL')
        reject(new Error('Docker command output exceeds byte bound'))
        return
      }
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.on('data', (chunk: string) => append('stdout', chunk))
    child.stderr.on('data', (chunk: string) => append('stderr', chunk))

    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolve({ exitCode, stdout, stderr, termination })
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (reason: Exclude<ProbeTermination, 'completed'>) => {
      if (settled) return
      termination = reason
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
    }
    const abort = () => stop('cancelled')
    const timer = setTimeout(() => stop('timed-out'), options.timeoutMs ?? 30_000)

    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', reject)
    child.on('close', code => {
      if (killTimer !== undefined) clearTimeout(killTimer)
      finish(code)
    })
  })
}

async function readOutputFiles(
  root: string,
  current = root,
  state = { entries: 0, bytes: 0 },
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    state.entries += 1
    if (state.entries > 32) throw new Error('Reviewer output exceeds entry bound')
    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      for (const [name, bytes] of await readOutputFiles(root, path, state)) files.set(name, bytes)
    } else if (entry.isFile()) {
      const metadata = await stat(path)
      const name = relative(root, path)
      const readableBytes = Math.min(metadata.size, 1024 * 1024)
      state.bytes += readableBytes
      if ((metadata.size > 1024 * 1024 && name !== 'response.txt') || state.bytes > 2 * 1024 * 1024)
        throw new Error('Reviewer output exceeds byte bound')
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const bytes = Buffer.alloc(readableBytes)
        let offset = 0
        while (offset < bytes.byteLength) {
          const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
          if (result.bytesRead === 0) break
          offset += result.bytesRead
        }
        files.set(name, bytes.subarray(0, offset))
      } finally {
        await handle.close()
      }
    } else throw new Error('Reviewer output contains an unsupported entry')
  }
  return files
}

async function hashOutputs(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const [name, bytes] of await readOutputFiles(root)) {
    hashes[name] = createHash('sha256').update(bytes).digest('hex')
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
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageDigest)) {
    throw new Error('Reviewer image must be addressed by an immutable sha256 image ID')
  }
  const resolved = await resolveReviewerIsolation({
    provider: plan.provider,
    bundleHostPath: plan.bundle.hostPath,
    outputHostPath: plan.output.hostPath,
    auth: plan.auth.map(({ hostPath, containerPath }) => ({ hostPath, containerPath })),
  })
  if (!resolved.ok) {
    throw new Error(`Reviewer mount plan refused (${resolved.reason}): ${resolved.detail}`)
  }
  plan = resolved.plan

  const [bundle, output, ...auth] = await Promise.all([
    stat(plan.bundle.hostPath),
    stat(plan.output.hostPath),
    ...plan.auth.map(({ hostPath }) => stat(hostPath)),
  ])
  if (!bundle.isDirectory() || !output.isDirectory() || auth.some(entry => !entry.isFile())) {
    throw new Error('Reviewer mounts require bundle/output directories and auth files')
  }
  const containerName = `factory-isolation-${randomUUID()}`
  const observedImage = await runCommand('docker', [
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    options.imageDigest,
  ])
  if (observedImage.exitCode !== 0 || observedImage.stdout.trim() !== options.imageDigest) {
    throw new Error('Docker could not verify the requested reviewer image ID')
  }
  const dockerArgs = [
    'create',
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
  dockerArgs.push(
    options.imageDigest,
    options.scenario ?? 'success',
    plan.provider,
    ...(options.reviewer === undefined
      ? []
      : [
          options.reviewer.model,
          options.reviewer.effort,
          options.reviewer.promptVersion,
          options.expectedBundleSha256 ?? '',
        ]),
  )

  let result: CommandResult | undefined
  let observation: ContainerObservation | undefined
  let inspectedMounts: IsolationReport['mounts'] = []
  let containerPolicy: IsolationReport['containerPolicy'] | undefined
  let creationAttempted = false
  let capturedLogs = ''
  let probeFailure: unknown
  let removalFailure: Error | undefined
  try {
    creationAttempted = true
    const created = await runCommand('docker', dockerArgs)
    if (created.exitCode !== 0) {
      throw new Error(`Docker refused reviewer container: ${created.stderr.trim()}`)
    }
    const inspected = await runCommand('docker', ['inspect', containerName])
    if (inspected.exitCode !== 0) {
      throw new Error('Docker could not inspect the reviewer container')
    }
    const [container] = JSON.parse(inspected.stdout) as [
      {
        Config: { User: string }
        HostConfig: {
          NetworkMode: string
          ReadonlyRootfs: boolean
          CapDrop: string[] | null
          SecurityOpt: string[] | null
          Tmpfs: Record<string, string> | null
        }
        Mounts: { Source: string; Destination: string; RW: boolean }[]
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
    const expectedSources = new Map([
      ['/bundle', plan.bundle.hostPath],
      ['/out', plan.output.hostPath],
      ...plan.auth.map(({ containerPath, hostPath }) => [containerPath, hostPath] as const),
    ])
    if (
      container.Mounts.some(
        ({ Source, Destination }) => expectedSources.get(Destination) !== Source,
      )
    ) {
      throw new Error('Docker reviewer container received an unexpected mount source')
    }
    const expectedModes = new Map([
      ['/bundle', 'ro'],
      ['/out', 'rw'],
      ...plan.auth.map(({ containerPath }) => [containerPath, 'ro'] as const),
    ])
    if (
      inspectedMounts.some(({ containerPath, mode }) => expectedModes.get(containerPath) !== mode)
    ) {
      throw new Error('Docker reviewer container received an unexpected mount mode')
    }
    containerPolicy = {
      readonlyRootfs: container.HostConfig.ReadonlyRootfs,
      user: container.Config.User,
      capDrop: container.HostConfig.CapDrop ?? [],
      securityOptions: container.HostConfig.SecurityOpt ?? [],
      tmpfsTargets: Object.keys(container.HostConfig.Tmpfs ?? {}).sort(),
    }
    if (
      container.HostConfig.NetworkMode !== 'bridge' ||
      !containerPolicy.readonlyRootfs ||
      containerPolicy.user !== '65532:65532' ||
      !containerPolicy.capDrop.includes('ALL') ||
      !containerPolicy.securityOptions.some(option => option.startsWith('no-new-privileges')) ||
      !containerPolicy.tmpfsTargets.includes('/tmp')
    ) {
      throw new Error('Docker reviewer container did not satisfy the required security policy')
    }
    const started = await runCommand('docker', ['start', containerName])
    if (started.exitCode !== 0) {
      throw new Error(`Docker could not start reviewer container: ${started.stderr.trim()}`)
    }
    const waited = await runCommand('docker', ['wait', containerName], {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    })
    const containerExitCode =
      waited.termination === 'completed' ? Number.parseInt(waited.stdout.trim(), 10) : null
    result = { ...waited, exitCode: containerExitCode }
    if (waited.termination !== 'completed') {
      const killed = await runCommand('docker', ['kill', containerName])
      if (killed.exitCode !== 0) {
        throw new Error(`Docker could not stop reviewer container: ${killed.stderr.trim()}`)
      }
    }
    const logs = await runCommand('docker', ['logs', containerName])
    if (logs.exitCode !== 0) {
      throw new Error(`Docker could not read reviewer logs: ${logs.stderr.trim()}`)
    }
    capturedLogs = `${logs.stdout}\n${logs.stderr}`
    if (result.termination === 'completed' && result.exitCode === 0) {
      observation = JSON.parse(logs.stdout) as ContainerObservation
    }
  } catch (error) {
    probeFailure = error
  } finally {
    if (creationAttempted) {
      const removed = await runCommand('docker', ['rm', '--force', containerName])
      if (removed.exitCode !== 0 && !removed.stderr.toLowerCase().includes('no such container'))
        removalFailure = new Error(
          `Docker could not remove reviewer container: ${removed.stderr.trim()}`,
        )
    }
  }

  if (removalFailure !== undefined && probeFailure !== undefined) {
    throw new AggregateError(
      [probeFailure, removalFailure],
      'Reviewer probe and cleanup both failed',
    )
  }
  if (removalFailure !== undefined) throw removalFailure
  if (probeFailure !== undefined) throw probeFailure

  if (result === undefined) throw new Error('Docker probe did not start')
  if (containerPolicy === undefined) {
    throw new Error('Docker probe policy was not observed')
  }
  const inspect = await runCommand('docker', ['inspect', containerName])
  if (inspect.exitCode === 0 || !inspect.stderr.toLowerCase().includes('no such object')) {
    throw new Error('Docker could not prove the reviewer container was removed')
  }
  const outputFiles = await readOutputFiles(plan.output.hostPath)
  const leakSurfaces = [capturedLogs, ...outputFiles.values()].map(value => value.toString())
  if (
    options.sensitiveValues?.some(secret => leakSurfaces.some(surface => surface.includes(secret)))
  ) {
    throw new Error('Sensitive value escaped into reviewer logs or output')
  }

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
    cleanup: { containerRemoved: true },
  }
}
