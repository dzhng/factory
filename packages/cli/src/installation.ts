import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import {
  createCaptureAdapter,
  isCaptureHookEvent,
  removeOwnedHooks,
  type HookInspection,
} from '@factory/capture'
import { canonicalJson } from '@factory/contract'
import { withAdvisoryFileLock } from '@factory/repository'
import type { CaptureProvider } from '@factory/runtime-journal'

import {
  atomicExecutableWrite,
  atomicPrivateWrite,
  configRoot,
  pathKind,
  readBoundedOrdinaryFile,
  syncDirectory,
} from './private-files'
import { assertVerifiedRelease, type VerifiedRelease } from './release-manifest'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const MAX_PROVIDER_CONFIG_BYTES = 4 * 1024 * 1024

type OwnedFingerprint = { event: string; fingerprint: string }
export type HookState = {
  schemaVersion: 1
  executable: string
  providers: Partial<
    Record<CaptureProvider, { path: string; fingerprints: readonly OwnedFingerprint[] }>
  >
}

export type InstallationStatus = {
  ownership: 'absent' | 'available' | 'invalid'
  ownershipError?: string
  executable: {
    path: string | null
    state: 'unconfigured' | 'ready' | 'missing' | 'unsafe' | 'not-executable'
  }
  transaction: 'absent' | 'pending' | 'invalid'
  transactionError?: string
  providers: Record<
    CaptureProvider,
    {
      path: string
      config: 'missing' | 'available' | 'invalid'
      error?: string
      hooks?: HookInspection
    }
  >
}

export function providerPath(provider: CaptureProvider, environment: NodeJS.ProcessEnv): string {
  if (provider === 'codex') {
    return join(
      environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), '.codex'),
      'hooks.json',
    )
  }
  return join(
    environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? homedir(), '.claude'),
    'settings.json',
  )
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return value !== null && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

function parseHookState(value: unknown, environment: NodeJS.ProcessEnv): HookState {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    !exactKeys(value as Record<string, unknown>, ['schemaVersion', 'executable', 'providers'])
  )
    throw new Error('Factory hook state is invalid')
  const candidate = value as Record<string, unknown>
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.executable !== 'string' ||
    !isAbsolute(candidate.executable) ||
    candidate.providers === null ||
    Array.isArray(candidate.providers) ||
    typeof candidate.providers !== 'object'
  )
    throw new Error('Factory hook state is invalid')
  const providers = candidate.providers as Record<string, unknown>
  if (Object.keys(providers).some(provider => provider !== 'codex' && provider !== 'claude'))
    throw new Error('Factory hook state is invalid')
  for (const provider of ['codex', 'claude'] as const) {
    const owned = providers[provider]
    if (owned === undefined) continue
    if (
      owned === null ||
      Array.isArray(owned) ||
      typeof owned !== 'object' ||
      !exactKeys(owned as Record<string, unknown>, ['path', 'fingerprints'])
    )
      throw new Error('Factory hook state is invalid')
    const record = owned as Record<string, unknown>
    if (record.path !== providerPath(provider, environment) || !Array.isArray(record.fingerprints))
      throw new Error('Factory hook state is invalid')
    const identities = new Set<string>()
    for (const fingerprint of record.fingerprints) {
      if (
        fingerprint === null ||
        Array.isArray(fingerprint) ||
        typeof fingerprint !== 'object' ||
        !exactKeys(fingerprint as Record<string, unknown>, ['event', 'fingerprint'])
      )
        throw new Error('Factory hook state is invalid')
      const entry = fingerprint as Record<string, unknown>
      if (
        !isCaptureHookEvent(provider, entry.event) ||
        typeof entry.fingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.fingerprint) ||
        identities.has(`${entry.event}\0${entry.fingerprint}`)
      )
        throw new Error('Factory hook state is invalid')
      identities.add(`${entry.event}\0${entry.fingerprint}`)
    }
  }
  return value as HookState
}

export async function readHookState(
  environment: NodeJS.ProcessEnv,
): Promise<HookState | undefined> {
  const bytes = await readBoundedOrdinaryFile(
    join(configRoot(environment), 'hooks-state.json'),
    1024 * 1024,
  )
  if (bytes === undefined) return undefined
  return parseHookState(JSON.parse(decoder.decode(bytes)), environment)
}

export async function inspectInstallation(
  environment: NodeJS.ProcessEnv,
): Promise<InstallationStatus> {
  let state: HookState | undefined
  let ownership: InstallationStatus['ownership'] = 'absent'
  let ownershipError: string | undefined
  try {
    state = await readHookState(environment)
    if (state !== undefined) ownership = 'available'
  } catch (error) {
    ownership = 'invalid'
    ownershipError = error instanceof Error ? error.message : String(error)
  }
  const executable = await inspectExecutable(state?.executable)
  const transactionInspection = await inspectTransaction(environment)
  const providers = {} as InstallationStatus['providers']
  for (const provider of ['codex', 'claude'] as const) {
    const path = providerPath(provider, environment)
    try {
      const bytes = await readBoundedOrdinaryFile(path, MAX_PROVIDER_CONFIG_BYTES)
      providers[provider] = {
        path,
        config: bytes === undefined ? 'missing' : 'available',
        hooks: createCaptureAdapter(
          provider,
          state?.providers[provider]?.fingerprints,
        ).inspectHooks(bytes, state?.executable),
      }
    } catch (error) {
      providers[provider] = {
        path,
        config: 'invalid',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return {
    ownership,
    ...(ownershipError === undefined ? {} : { ownershipError }),
    executable,
    transaction: transactionInspection.state,
    ...(transactionInspection.error === undefined
      ? {}
      : { transactionError: transactionInspection.error }),
    providers,
  }
}

type HookReconciliationTransaction = {
  schemaVersion: 1
  kind: 'hook-reconciliation'
  provider: CaptureProvider
  path: string
  beforeSha256: string
  afterSha256: string
  bytes: string
  nextState: HookState
}

type ExecutableReplacementTransaction = {
  schemaVersion: 1
  kind: 'executable-replacement'
  path: string
  stagedPath: string
  stage: 'planned' | 'verified'
  beforeSha256: string
  afterSha256: string
  release: {
    version: string
    revision: string
    target: string
    manifestSha256: string
  }
  nextState: HookState
}

type InstallationTransaction = HookReconciliationTransaction | ExecutableReplacementTransaction

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function parseInstallationTransaction(
  value: unknown,
  environment: NodeJS.ProcessEnv,
): InstallationTransaction {
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new Error('interrupted installation transaction is invalid')
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'executable-replacement') {
    if (
      !exactKeys(candidate, [
        'schemaVersion',
        'kind',
        'path',
        'stagedPath',
        'stage',
        'beforeSha256',
        'afterSha256',
        'release',
        'nextState',
      ]) ||
      candidate.schemaVersion !== 1 ||
      typeof candidate.path !== 'string' ||
      !isAbsolute(candidate.path) ||
      typeof candidate.stagedPath !== 'string' ||
      dirname(candidate.stagedPath) !== dirname(candidate.path) ||
      !candidate.stagedPath.startsWith(`${candidate.path}.factory-upgrade-`) ||
      !candidate.stagedPath.endsWith('.new') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        candidate.stagedPath.slice(`${candidate.path}.factory-upgrade-`.length, -'.new'.length),
      ) ||
      (candidate.stage !== 'planned' && candidate.stage !== 'verified') ||
      !isSha256(candidate.beforeSha256) ||
      !isSha256(candidate.afterSha256) ||
      candidate.release === null ||
      Array.isArray(candidate.release) ||
      typeof candidate.release !== 'object' ||
      !exactKeys(candidate.release as Record<string, unknown>, [
        'version',
        'revision',
        'target',
        'manifestSha256',
      ])
    )
      throw new Error('interrupted installation transaction is invalid')
    const release = candidate.release as Record<string, unknown>
    if (
      typeof release.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version) ||
      typeof release.revision !== 'string' ||
      !/^[0-9a-f]{40}$/.test(release.revision) ||
      (release.target !== 'bun-darwin-arm64' && release.target !== 'bun-linux-x64-baseline') ||
      !isSha256(release.manifestSha256)
    )
      throw new Error('interrupted installation transaction is invalid')
    let nextState: HookState
    try {
      nextState = parseHookState(candidate.nextState, environment)
    } catch {
      throw new Error('interrupted installation transaction is invalid')
    }
    if (nextState.executable !== candidate.path)
      throw new Error('interrupted installation transaction is invalid')
    return { ...candidate, release, nextState } as ExecutableReplacementTransaction
  }
  if (
    !exactKeys(candidate, [
      'schemaVersion',
      'kind',
      'provider',
      'path',
      'beforeSha256',
      'afterSha256',
      'bytes',
      'nextState',
    ])
  )
    throw new Error('interrupted installation transaction is invalid')
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !== 'hook-reconciliation' ||
    (candidate.provider !== 'codex' && candidate.provider !== 'claude') ||
    candidate.path !== providerPath(candidate.provider, environment) ||
    !isSha256(candidate.beforeSha256) ||
    !isSha256(candidate.afterSha256) ||
    typeof candidate.bytes !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(candidate.bytes)
  )
    throw new Error('interrupted installation transaction is invalid')
  let nextState: HookState
  try {
    nextState = parseHookState(candidate.nextState, environment)
  } catch {
    throw new Error('interrupted installation transaction is invalid')
  }
  return { ...candidate, nextState } as HookReconciliationTransaction
}

async function readInstallationTransaction(
  environment: NodeJS.ProcessEnv,
): Promise<InstallationTransaction | undefined> {
  const bytes = await readBoundedOrdinaryFile(
    join(configRoot(environment), 'installation-transaction.json'),
    2 * 1024 * 1024,
  )
  return bytes === undefined
    ? undefined
    : parseInstallationTransaction(JSON.parse(decoder.decode(bytes)), environment)
}

type ValidatedInstallationTransaction =
  | { journal: HookReconciliationTransaction; bytes: Uint8Array; currentHash: string }
  | {
      journal: ExecutableReplacementTransaction
      currentHash: string
      staged: 'missing' | 'available'
    }

function sameFingerprints(
  left: readonly OwnedFingerprint[],
  right: readonly OwnedFingerprint[],
): boolean {
  const identity = (entry: OwnedFingerprint) => `${entry.event}\0${entry.fingerprint}`
  return (
    left.length === right.length &&
    [...left].map(identity).sort().join('\0') === [...right].map(identity).sort().join('\0')
  )
}

async function validateInstallationTransaction(
  environment: NodeJS.ProcessEnv,
): Promise<ValidatedInstallationTransaction | undefined> {
  const journal = await readInstallationTransaction(environment)
  if (journal === undefined) return undefined
  if (journal.kind === 'executable-replacement') {
    if (journal.release.target !== releaseTargetForCurrentHost())
      throw new Error('interrupted Factory upgrade targets a different platform')
    const current = await readBoundedOrdinaryFile(journal.path, 96 * 1024 * 1024)
    if (current === undefined)
      throw new Error('installed executable disappeared during Factory upgrade')
    const currentHash = createHash('sha256').update(current).digest('hex')
    if (currentHash !== journal.beforeSha256 && currentHash !== journal.afterSha256)
      throw new Error('installed executable changed during interrupted Factory upgrade')
    const stagedBytes = await readBoundedOrdinaryFile(journal.stagedPath, 96 * 1024 * 1024)
    if (
      journal.stage === 'verified' &&
      currentHash === journal.beforeSha256 &&
      journal.beforeSha256 !== journal.afterSha256 &&
      stagedBytes === undefined
    )
      throw new Error('verified staged Factory upgrade executable is missing')
    if (
      journal.stage === 'verified' &&
      stagedBytes !== undefined &&
      createHash('sha256').update(stagedBytes).digest('hex') !== journal.afterSha256
    )
      throw new Error('staged Factory upgrade executable is corrupt')
    if (journal.stage === 'verified' && stagedBytes !== undefined) {
      await access(journal.stagedPath, constants.X_OK).catch(() => {
        throw new Error('staged Factory upgrade executable is not executable')
      })
    }
    return {
      journal,
      currentHash,
      staged: stagedBytes === undefined ? 'missing' : 'available',
    }
  }
  const bytes = Buffer.from(journal.bytes, 'base64')
  if (createHash('sha256').update(bytes).digest('hex') !== journal.afterSha256)
    throw new Error('interrupted installation transaction bytes are corrupt')

  const owned = journal.nextState.providers[journal.provider]
  if (owned !== undefined) {
    const inspection = createCaptureAdapter(journal.provider, owned.fingerprints).inspectHooks(
      bytes,
      journal.nextState.executable,
    )
    const desired = inspection.events.map(event => ({
      event: event.event,
      fingerprint: event.desiredFingerprint,
    }))
    if (
      inspection.events.some(event => event.state !== 'installed') ||
      !sameFingerprints(owned.fingerprints, desired)
    )
      throw new Error(
        'interrupted installation transaction ownership does not match provider hooks',
      )
  }

  const current = (await readProviderConfig(journal.path)) ?? encoder.encode('{}\n')
  const currentHash = createHash('sha256').update(current).digest('hex')
  if (currentHash !== journal.beforeSha256 && currentHash !== journal.afterSha256)
    throw new Error('provider hooks changed during interrupted Factory transaction')
  return { journal, bytes, currentHash }
}

async function inspectTransaction(
  environment: NodeJS.ProcessEnv,
): Promise<{ state: InstallationStatus['transaction']; error?: string }> {
  const path = join(configRoot(environment), 'installation-transaction.json')
  const kind = await pathKind(path)
  if (kind === 'missing') return { state: 'absent' }
  if (kind !== 'file') return { state: 'invalid', error: 'installation transaction is unsafe' }
  try {
    await validateInstallationTransaction(environment)
    return { state: 'pending' }
  } catch (error) {
    return { state: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

async function inspectExecutable(
  path: string | undefined,
): Promise<InstallationStatus['executable']> {
  if (path === undefined) return { path: null, state: 'unconfigured' }
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) return { path, state: 'unsafe' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, state: 'missing' }
    return { path, state: 'unsafe' }
  }
  try {
    await access(path, constants.X_OK)
    return { path, state: 'ready' }
  } catch {
    return { path, state: 'not-executable' }
  }
}

async function readProviderConfig(path: string): Promise<Uint8Array | undefined> {
  return await readBoundedOrdinaryFile(path, MAX_PROVIDER_CONFIG_BYTES)
}

async function applyHookPatch(
  provider: CaptureProvider,
  path: string,
  expected: Uint8Array | undefined,
  bytes: Uint8Array,
  nextState: HookState,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const root = configRoot(environment)
  const journalPath = join(root, 'installation-transaction.json')
  const before = (await readProviderConfig(path)) ?? encoder.encode('{}\n')
  const expectedBefore = expected ?? encoder.encode('{}\n')
  if (!Buffer.from(before).equals(expectedBefore))
    throw new Error('provider hooks changed while Factory prepared its patch')
  const journal = {
    schemaVersion: 1,
    kind: 'hook-reconciliation',
    provider,
    path,
    beforeSha256: createHash('sha256').update(before).digest('hex'),
    afterSha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: Buffer.from(bytes).toString('base64'),
    nextState,
  }
  await atomicPrivateWrite(journalPath, encoder.encode(canonicalJson(journal)))
  if (process.env.FACTORY_TEST_HOOK_CRASH === 'after-journal') throw new Error('injected crash')
  const prewrite = (await readProviderConfig(path)) ?? encoder.encode('{}\n')
  if (!Buffer.from(prewrite).equals(expectedBefore)) {
    await unlink(journalPath)
    await syncDirectory(root)
    throw new Error('provider hooks changed while Factory prepared its patch')
  }
  await atomicPrivateWrite(path, bytes)
  if (process.env.FACTORY_TEST_HOOK_CRASH === 'after-config') throw new Error('injected crash')
  await atomicPrivateWrite(join(root, 'hooks-state.json'), encoder.encode(canonicalJson(nextState)))
  await unlink(journalPath)
  await syncDirectory(root)
}

async function recoverInstallationTransactionUnlocked(
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const root = configRoot(environment)
  const path = join(root, 'installation-transaction.json')
  const validated = await validateInstallationTransaction(environment)
  if (validated === undefined) return
  if ('staged' in validated) {
    if (validated.journal.stage === 'planned') {
      if (validated.currentHash !== validated.journal.beforeSha256)
        throw new Error('installed executable changed during interrupted Factory upgrade')
      if (validated.staged === 'available') {
        await unlink(validated.journal.stagedPath)
        await syncDirectory(dirname(validated.journal.stagedPath))
      }
      await unlink(path)
      await syncDirectory(root)
      return
    }
    if (validated.currentHash === validated.journal.beforeSha256) {
      if (validated.staged === 'missing') {
        if (validated.journal.beforeSha256 !== validated.journal.afterSha256)
          throw new Error('verified staged Factory upgrade executable is missing')
      } else {
        await promoteVerifiedExecutable(validated.journal)
      }
    } else if (validated.staged === 'available') {
      await unlink(validated.journal.stagedPath)
      await syncDirectory(dirname(validated.journal.stagedPath))
    }
    await atomicPrivateWrite(
      join(root, 'hooks-state.json'),
      encoder.encode(canonicalJson(validated.journal.nextState)),
    )
    await unlink(path)
    await syncDirectory(root)
    return
  }
  if (validated.currentHash === validated.journal.beforeSha256) {
    await unlink(path)
    await syncDirectory(root)
    return
  }
  await atomicPrivateWrite(
    join(root, 'hooks-state.json'),
    encoder.encode(canonicalJson(validated.journal.nextState)),
  )
  await unlink(path)
  await syncDirectory(root)
}

async function withInstallationLock<T>(
  environment: NodeJS.ProcessEnv,
  operation: () => Promise<T>,
): Promise<T> {
  const root = configRoot(environment)
  await mkdir(root, { recursive: true, mode: 0o700 })
  return await withAdvisoryFileLock(join(root, 'installation.lock'), 30_000, operation)
}

export async function recoverInstallationTransaction(
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await withInstallationLock(environment, async () => {
    await recoverInstallationTransactionUnlocked(environment)
  })
}

export function releaseTargetForCurrentHost():
  | 'bun-darwin-arm64'
  | 'bun-linux-x64-baseline'
  | undefined {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'bun-darwin-arm64'
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: unknown } }
    | undefined
  if (
    process.platform === 'linux' &&
    process.arch === 'x64' &&
    typeof report?.header?.glibcVersionRuntime === 'string'
  )
    return 'bun-linux-x64-baseline'
  return undefined
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.byteLength
    if (total > maximumBytes) throw new Error('staged Factory output exceeds its size bound')
    chunks.push(chunk.slice())
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

async function verifyStagedExecutable(path: string, version: string): Promise<void> {
  const child = Bun.spawn([path, '--version'], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [code, stdout, stderr] = await Promise.race([
      Promise.all([
        child.exited,
        readBoundedStream(child.stdout, 1024),
        readBoundedStream(child.stderr, 1024),
      ]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('staged Factory executable timed out')), 5_000)
      }),
    ])
    if (code !== 0 || stderr.byteLength !== 0 || decoder.decode(stdout) !== `${version}\n`) {
      throw new Error('staged Factory executable failed its version check')
    }
  } catch (error) {
    child.kill(9)
    await child.exited.catch(() => undefined)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function digestExecutable(path: string, role: 'installed' | 'staged'): Promise<string> {
  const bytes = await readBoundedOrdinaryFile(path, 96 * 1024 * 1024)
  if (bytes === undefined) throw new Error(`${role} Factory executable is missing`)
  await access(path, constants.X_OK).catch(() => {
    throw new Error(`${role} Factory executable is not executable`)
  })
  return createHash('sha256').update(bytes).digest('hex')
}

async function promoteVerifiedExecutable(
  transaction: ExecutableReplacementTransaction,
): Promise<void> {
  if ((await digestExecutable(transaction.path, 'installed')) !== transaction.beforeSha256)
    throw new Error('installed executable changed during Factory upgrade')
  if ((await digestExecutable(transaction.stagedPath, 'staged')) !== transaction.afterSha256)
    throw new Error('staged Factory upgrade executable changed after verification')
  await rename(transaction.stagedPath, transaction.path)
  await syncDirectory(dirname(transaction.path))
  if ((await digestExecutable(transaction.path, 'installed')) !== transaction.afterSha256)
    throw new Error('installed Factory executable does not match the verified release')
}

export async function upgradeInstallation(
  release: VerifiedRelease,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  assertVerifiedRelease(release)
  const expectedTarget = releaseTargetForCurrentHost()
  if (expectedTarget === undefined || release.target !== expectedTarget)
    throw new Error('verified release does not match this platform')
  if (createHash('sha256').update(release.executable).digest('hex') !== release.executableSha256)
    throw new Error('verified release executable capability changed')
  await withInstallationLock(environment, async () => {
    const root = configRoot(environment)
    await recoverInstallationTransactionUnlocked(environment)
    const state = await readHookState(environment)
    if (state === undefined) throw new Error('Factory must be installed before it can be upgraded')
    const current = await readBoundedOrdinaryFile(state.executable, 96 * 1024 * 1024)
    if (current === undefined) throw new Error('installed Factory executable is missing')
    const stagedPath = `${state.executable}.factory-upgrade-${randomUUID()}.new`
    const transaction: ExecutableReplacementTransaction = {
      schemaVersion: 1,
      kind: 'executable-replacement',
      path: state.executable,
      stagedPath,
      stage: 'planned',
      beforeSha256: createHash('sha256').update(current).digest('hex'),
      afterSha256: release.executableSha256,
      release: {
        version: release.version,
        revision: release.revision,
        target: release.target,
        manifestSha256: release.manifestSha256,
      },
      nextState: state,
    }
    const journalPath = join(root, 'installation-transaction.json')
    await atomicPrivateWrite(journalPath, encoder.encode(canonicalJson(transaction)))
    if (process.env.FACTORY_TEST_UPGRADE_CRASH === 'after-journal')
      throw new Error('injected crash')
    await atomicExecutableWrite(stagedPath, release.executable)
    await verifyStagedExecutable(stagedPath, release.version)
    transaction.stage = 'verified'
    await atomicPrivateWrite(journalPath, encoder.encode(canonicalJson(transaction)))
    if (process.env.FACTORY_TEST_UPGRADE_CRASH === 'after-stage') throw new Error('injected crash')
    await promoteVerifiedExecutable(transaction)
    if (process.env.FACTORY_TEST_UPGRADE_CRASH === 'after-executable')
      throw new Error('injected crash')
    await atomicPrivateWrite(join(root, 'hooks-state.json'), encoder.encode(canonicalJson(state)))
    await unlink(journalPath)
    await syncDirectory(root)
    await installHooksUnlocked(state.executable, environment)
  })
}

async function installHooksUnlocked(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<HookState> {
  if (!isAbsolute(executable) || (await pathKind(executable)) !== 'file')
    throw new Error('Factory hook executable must be an existing absolute ordinary file')
  await access(executable, constants.X_OK).catch(() => {
    throw new Error('Factory hook executable must be executable')
  })
  await recoverInstallationTransactionUnlocked(environment)
  let state: HookState = (await readHookState(environment)) ?? {
    schemaVersion: 1,
    executable,
    providers: {},
  }
  for (const provider of ['codex', 'claude'] as const) {
    const path = providerPath(provider, environment)
    const existing = await readProviderConfig(path)
    const patch = createCaptureAdapter(
      provider,
      state.providers[provider]?.fingerprints,
    ).reconcileHooks(existing, executable)
    state = {
      schemaVersion: 1,
      executable,
      providers: {
        ...state.providers,
        [provider]: { path, fingerprints: patch.ownedFingerprints },
      },
    }
    await applyHookPatch(provider, path, existing, patch.bytes, state, environment)
  }
  return state
}

export async function installHooks(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<HookState> {
  return await withInstallationLock(environment, async () => {
    return await installHooksUnlocked(executable, environment)
  })
}

async function uninstallHooksUnlocked(environment: NodeJS.ProcessEnv): Promise<void> {
  await recoverInstallationTransactionUnlocked(environment)
  let state = await readHookState(environment)
  if (state === undefined) return
  for (const provider of ['codex', 'claude'] as const) {
    const owned = state.providers[provider]
    if (owned === undefined) continue
    if (owned.path !== providerPath(provider, environment))
      throw new Error('Factory hook ownership state targets an unexpected provider path')
    const existing = await readProviderConfig(owned.path)
    const providers: HookState['providers'] = { ...state.providers }
    delete providers[provider]
    state = { ...state, providers }
    if (existing === undefined) {
      await atomicPrivateWrite(
        join(configRoot(environment), 'hooks-state.json'),
        encoder.encode(canonicalJson(state)),
      )
      continue
    }
    const patch = removeOwnedHooks(provider, existing, owned.fingerprints)
    await applyHookPatch(provider, owned.path, existing, patch.bytes, state, environment)
  }
}

export async function uninstallHooks(environment: NodeJS.ProcessEnv): Promise<void> {
  await withInstallationLock(environment, async () => {
    await uninstallHooksUnlocked(environment)
  })
}
