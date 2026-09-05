import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { ReviewerAdapterInvocation } from './adapter.js'
import { resolveIsolation, type IsolationProvider, type MountPlan } from './isolation.js'

export type ProbeTermination = 'completed' | 'timed-out' | 'cancelled'

export class ReviewerCleanupUnprovenError extends Error {
  constructor(options?: ErrorOptions) {
    super('Factory could not prove reviewer container cleanup', options)
    this.name = 'ReviewerCleanupUnprovenError'
  }
}

/** Docker could not establish a reviewer process, so no provider crash occurred. */
export class ReviewerDockerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewerDockerUnavailableError'
  }
}

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
  provider: IsolationProvider
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
    fileSizeBytes: number
  }
  termination: ProbeTermination
  exitCode: number | null
  observation?: ContainerObservation
  outputHashes: Readonly<Record<string, string>>
  cleanup: { containerRemoved: boolean }
}

export type ObservedContainerOptions = {
  /** Exact immutable image identity; mutable tags are refused. */
  imageDigest: string
  expectedBundleSha256?: string
  reviewer?: { model: string; effort: string; promptVersion: string }
  invocation?: ReviewerAdapterInvocation
  containerIdentity?: { name: string; label: string }
  scenario?: 'success' | 'hang' | 'descendant' | 'review'
  timeoutMs?: number
  /** Provider-only deadline inside the already-started pinned runner. */
  providerTimeoutMs?: number
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

/** Remove only the exact durable Factory-owned container for one logical attempt. */
export async function cleanupOwnedReviewerContainer(
  identity: { name: string; label: string },
  timeoutMs = 30_000,
): Promise<void> {
  const inspected = await runCommand(
    'docker',
    ['inspect', '--format', '{{ index .Config.Labels "factory.review-attempt" }}', identity.name],
    { timeoutMs },
  )
  if (inspected.exitCode !== 0) {
    if (inspected.stderr.toLowerCase().includes('no such object')) return
    throw new Error('Docker could not inspect the prior reviewer container')
  }
  if (inspected.stdout.trim() !== identity.label)
    throw new Error('Factory refuses to remove a reviewer container it does not own')
  const removed = await runCommand('docker', ['rm', '--force', identity.name], { timeoutMs })
  if (removed.exitCode !== 0)
    throw new Error('Docker could not remove the prior reviewer container')
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
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      child.kill('SIGKILL')
      reject(error)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      if (settled) return
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > 1024 * 1024) {
        fail(new Error('Docker command output exceeds byte bound'))
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
      cleanup()
      resolve({ exitCode, stdout, stderr, termination })
    }
    const stop = (reason: Exclude<ProbeTermination, 'completed'>) => {
      if (settled) return
      termination = reason
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
    }
    const abort = () => stop('cancelled')
    timer = setTimeout(() => stop('timed-out'), options.timeoutMs ?? 30_000)

    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', error => fail(error))
    child.on('close', code => {
      finish(code)
    })
  })
}

async function readOutputFiles(
  root: string,
  current = root,
  state = { entries: 0, bytes: 0 },
  rejectDirectories = false,
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    state.entries += 1
    if (state.entries > 32) throw new Error('Reviewer output exceeds entry bound')
    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      if (rejectDirectories) throw new Error('Reviewer output contains a foreign directory')
      for (const [name, bytes] of await readOutputFiles(root, path, state, rejectDirectories))
        files.set(name, bytes)
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

async function hashOutputs(files: ReadonlyMap<string, Buffer>): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const [name, bytes] of files) {
    hashes[name] = createHash('sha256').update(bytes).digest('hex')
  }
  return hashes
}

function dockerMount(hostPath: string, containerPath: string, readonly: boolean) {
  return `type=bind,src=${hostPath},dst=${containerPath}${readonly ? ',readonly' : ''}`
}

async function boundedFileSha256(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > 1024 * 1024)
      throw new Error('reviewer authentication is not a bounded ordinary file')
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, before.size)))
    let offset = 0
    while (offset < before.size) {
      const read = await handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset)
      if (read.bytesRead === 0) break
      hash.update(chunk.subarray(0, read.bytesRead))
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (
      offset !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    )
      throw new Error('reviewer authentication changed while it was read')
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

export async function runObservedReviewerContainer(
  plan: MountPlan<IsolationProvider>,
  options: ObservedContainerOptions,
): Promise<IsolationReport> {
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageDigest)) {
    throw new Error('Reviewer image must be addressed by an immutable sha256 image ID')
  }
  if (
    options.providerTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.providerTimeoutMs) || options.providerTimeoutMs < 1)
  )
    throw new TypeError('providerTimeoutMs must be a positive integer')
  const resolved = await resolveIsolation({
    provider: plan.provider,
    bundleHostPath: plan.bundle.hostPath,
    outputHostPath: plan.output.hostPath,
    auth: plan.auth,
  })
  if (!resolved.ok) {
    throw new Error(`Reviewer mount plan refused (${resolved.reason}): ${resolved.detail}`)
  }
  plan = resolved.plan
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  const commandOptions = () => ({
    timeoutMs: Math.max(1, deadline - Date.now()),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })

  const [bundle, output, ...auth] = await Promise.all([
    stat(plan.bundle.hostPath),
    stat(plan.output.hostPath),
    ...plan.auth.map(({ hostPath }) => stat(hostPath)),
  ])
  if (!bundle.isDirectory() || !output.isDirectory() || auth.some(entry => !entry.isFile())) {
    throw new Error('Reviewer mounts require bundle/output directories and auth files')
  }
  if (
    auth.some((entry, index) => {
      const expected = plan.auth[index]?.expectedIdentity
      return (
        expected !== undefined &&
        (entry.dev !== expected.dev ||
          entry.ino !== expected.ino ||
          entry.size !== expected.size ||
          entry.uid !== expected.uid ||
          entry.mode !== expected.mode)
      )
    })
  )
    throw new Error('Reviewer authentication differs from its selected identity')
  if (auth.length > 1) throw new Error('Reviewer execution accepts one provider auth file')
  const privateAuth = auth[0] !== undefined && (auth[0].mode & 0o004) === 0
  if (privateAuth && auth[0]!.uid === 0)
    throw new Error('Factory refuses root-owned private reviewer authentication')
  const containerUser = privateAuth ? `${auth[0]!.uid}:65532` : '65532:65532'
  const containerIdentity = options.containerIdentity ?? {
    name: `factory-isolation-${randomUUID()}`,
    label: randomUUID(),
  }
  const containerName = containerIdentity.name
  const reviewMode = options.scenario === 'review'
  const authSha256 =
    reviewMode && plan.auth[0] !== undefined
      ? await boundedFileSha256(plan.auth[0].hostPath)
      : undefined
  const bundleTarget = reviewMode ? '/review-input' : plan.bundle.containerPath
  const observedImage = await runCommand(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}', options.imageDigest],
    commandOptions(),
  )
  if (observedImage.exitCode !== 0 || observedImage.stdout.trim() !== options.imageDigest) {
    throw new ReviewerDockerUnavailableError(
      'Docker could not verify the requested reviewer image ID',
    )
  }
  const dockerArgs = [
    'create',
    '--name',
    containerName,
    '--label',
    `factory.review-attempt=${containerIdentity.label}`,
    '--network',
    'bridge',
    '--read-only',
    '--user',
    containerUser,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--ulimit',
    'fsize=1048576:1048576',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount',
    dockerMount(plan.bundle.hostPath, bundleTarget, true),
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
          Buffer.from(JSON.stringify(options.invocation ?? null)).toString('base64'),
          String(options.providerTimeoutMs ?? Math.max(1, deadline - Date.now())),
          authSha256 ?? '',
        ]),
  )

  let result: CommandResult | undefined
  let observation: ContainerObservation | undefined
  let inspectedMounts: IsolationReport['mounts'] = []
  let containerPolicy: IsolationReport['containerPolicy'] | undefined
  let creationSucceeded = false
  let creationInvoked = false
  let creationResolved = false
  let capturedLogs = ''
  let probeFailure: unknown
  let removalFailure: Error | undefined
  try {
    const currentAuth = await Promise.all(plan.auth.map(({ hostPath }) => lstat(hostPath)))
    if (
      currentAuth.some((entry, index) => {
        const before = auth[index]
        return (
          before === undefined ||
          !entry.isFile() ||
          entry.dev !== before.dev ||
          entry.ino !== before.ino ||
          entry.size !== before.size ||
          entry.uid !== before.uid ||
          entry.mode !== before.mode
        )
      })
    )
      throw new Error('Reviewer authentication changed before container creation')
    creationInvoked = true
    let created: CommandResult
    try {
      created = await runCommand('docker', dockerArgs, commandOptions())
      creationResolved = created.termination === 'completed'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') creationInvoked = false
      throw error
    }
    if (created.exitCode !== 0) {
      throw new ReviewerDockerUnavailableError(
        `Docker refused reviewer container: ${created.stderr.trim()}`,
      )
    }
    creationSucceeded = true
    const mountedAuth = await Promise.all(plan.auth.map(({ hostPath }) => lstat(hostPath)))
    if (
      mountedAuth.some((entry, index) => {
        const before = auth[index]
        return (
          before === undefined ||
          !entry.isFile() ||
          entry.dev !== before.dev ||
          entry.ino !== before.ino ||
          entry.size !== before.size ||
          entry.uid !== before.uid ||
          entry.mode !== before.mode
        )
      })
    )
      throw new Error('Reviewer authentication changed after container creation')
    if (
      authSha256 !== undefined &&
      (await boundedFileSha256(plan.auth[0]!.hostPath)) !== authSha256
    )
      throw new Error('Reviewer authentication contents changed after container creation')
    const inspected = await runCommand('docker', ['inspect', containerName], commandOptions())
    if (inspected.exitCode !== 0) {
      throw new ReviewerDockerUnavailableError('Docker could not inspect the reviewer container')
    }
    const [container] = JSON.parse(inspected.stdout) as [
      {
        Config: { User: string; Labels?: Record<string, string> }
        HostConfig: {
          NetworkMode: string
          ReadonlyRootfs: boolean
          CapDrop: string[] | null
          SecurityOpt: string[] | null
          Tmpfs: Record<string, string> | null
          Ulimits: { Name: string; Soft: number; Hard: number }[] | null
        }
        Mounts: { Source: string; Destination: string; RW: boolean }[]
      },
    ]
    if (container === undefined) {
      throw new Error('Docker returned no reviewer container inspection')
    }
    if (container.Config.Labels?.['factory.review-attempt'] !== containerIdentity.label)
      throw new Error('Docker reviewer container has the wrong Factory ownership label')
    inspectedMounts = container.Mounts.map(
      ({ Destination, RW }): IsolationReport['mounts'][number] => ({
        role:
          Destination === '/bundle' || Destination === '/review-input'
            ? 'bundle'
            : Destination === '/out'
              ? 'output'
              : 'auth',
        containerPath: Destination,
        mode: RW ? 'rw' : 'ro',
      }),
    ).sort((left, right) => left.containerPath.localeCompare(right.containerPath))
    const expectedTargets = [
      bundleTarget,
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
      [bundleTarget, plan.bundle.hostPath],
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
      [bundleTarget, 'ro'],
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
      fileSizeBytes:
        container.HostConfig.Ulimits?.find(limit => limit.Name === 'fsize')?.Soft ?? -1,
    }
    if (
      container.HostConfig.NetworkMode !== 'bridge' ||
      !containerPolicy.readonlyRootfs ||
      containerPolicy.user !== containerUser ||
      !containerPolicy.capDrop.includes('ALL') ||
      !containerPolicy.securityOptions.some(option => option.startsWith('no-new-privileges')) ||
      containerPolicy.fileSizeBytes !== 1024 * 1024 ||
      container.HostConfig.Ulimits?.find(limit => limit.Name === 'fsize')?.Hard !== 1024 * 1024 ||
      container.HostConfig.Tmpfs?.['/review-input'] !== undefined ||
      canonicalTmpfs(container.HostConfig.Tmpfs?.['/tmp']) !==
        canonicalTmpfs('rw,noexec,nosuid,nodev,size=16m')
    ) {
      throw new Error('Docker reviewer container did not satisfy the required security policy')
    }
    const started = await runCommand('docker', ['start', containerName], commandOptions())
    if (started.exitCode !== 0) {
      throw new ReviewerDockerUnavailableError(
        `Docker could not start reviewer container: ${started.stderr.trim()}`,
      )
    }
    const waited = await runCommand('docker', ['wait', containerName], {
      ...commandOptions(),
    })
    const containerExitCode =
      waited.termination === 'completed' ? Number.parseInt(waited.stdout.trim(), 10) : null
    result =
      reviewMode && containerExitCode === 124
        ? { ...waited, termination: 'timed-out', exitCode: null }
        : { ...waited, exitCode: containerExitCode }
    if (waited.termination !== 'completed') {
      const killed = await runCommand('docker', ['kill', containerName], { timeoutMs: 5_000 })
      if (killed.exitCode !== 0) {
        throw new Error(`Docker could not stop reviewer container: ${killed.stderr.trim()}`)
      }
    }
    const logs = await runCommand('docker', ['logs', containerName], { timeoutMs: 5_000 })
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
    const ambiguousCreation = creationInvoked && !creationResolved
    if (creationSucceeded || ambiguousCreation)
      await cleanupOwnedReviewerContainer(containerIdentity, 5_000).catch(error => {
        removalFailure = error instanceof Error ? error : new Error('reviewer cleanup failed')
      })
    if (ambiguousCreation && removalFailure === undefined)
      removalFailure = new Error('reviewer container creation did not reach a terminal result')
  }

  if (removalFailure !== undefined)
    throw new ReviewerCleanupUnprovenError({ cause: removalFailure })
  if (probeFailure !== undefined) throw probeFailure

  if (result === undefined) throw new Error('Reviewer container did not start')
  if (containerPolicy === undefined) {
    throw new Error('Reviewer container policy was not observed')
  }
  const inspect = await runCommand('docker', ['inspect', containerName], { timeoutMs: 5_000 })
  if (inspect.exitCode === 0 || !inspect.stderr.toLowerCase().includes('no such object')) {
    throw new ReviewerCleanupUnprovenError()
  }
  const outputFiles = await readOutputFiles(
    plan.output.hostPath,
    plan.output.hostPath,
    { entries: 0, bytes: 0 },
    options.scenario === 'review',
  )
  if (
    options.scenario === 'review' &&
    [...outputFiles.keys()].some(path => path !== 'response.txt')
  )
    throw new Error('Reviewer output contains a foreign file')
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
    outputHashes: await hashOutputs(outputFiles),
    cleanup: { containerRemoved: true },
  }
}

function canonicalTmpfs(value: string | undefined): string {
  return (value ?? '').split(',').filter(Boolean).sort().join(',')
}
