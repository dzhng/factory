import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import {
  createCaptureAdapter,
  isCaptureHookEvent,
  removeOwnedHooks,
  type HookInspection,
} from '@factory/capture'
import { canonicalJson } from '@factory/contract'
import type { CaptureProvider } from '@factory/runtime-journal'

import {
  atomicPrivateWrite,
  configRoot,
  pathKind,
  readBoundedOrdinaryFile,
  syncDirectory,
} from './private-files'

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

type HookTransaction = {
  schemaVersion: 1
  provider: CaptureProvider
  path: string
  beforeSha256: string
  afterSha256: string
  bytes: string
  nextState: HookState
}

function parseHookTransaction(value: unknown, environment: NodeJS.ProcessEnv): HookTransaction {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    !exactKeys(value as Record<string, unknown>, [
      'schemaVersion',
      'provider',
      'path',
      'beforeSha256',
      'afterSha256',
      'bytes',
      'nextState',
    ])
  )
    throw new Error('interrupted hook transaction is invalid')
  const candidate = value as Record<string, unknown>
  if (
    candidate.schemaVersion !== 1 ||
    (candidate.provider !== 'codex' && candidate.provider !== 'claude') ||
    candidate.path !== providerPath(candidate.provider, environment) ||
    typeof candidate.beforeSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.beforeSha256) ||
    typeof candidate.afterSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.afterSha256) ||
    typeof candidate.bytes !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(candidate.bytes)
  )
    throw new Error('interrupted hook transaction is invalid')
  let nextState: HookState
  try {
    nextState = parseHookState(candidate.nextState, environment)
  } catch {
    throw new Error('interrupted hook transaction is invalid')
  }
  return { ...candidate, nextState } as HookTransaction
}

async function readHookTransaction(
  environment: NodeJS.ProcessEnv,
): Promise<HookTransaction | undefined> {
  const bytes = await readBoundedOrdinaryFile(
    join(configRoot(environment), 'hook-transaction.json'),
    2 * 1024 * 1024,
  )
  return bytes === undefined
    ? undefined
    : parseHookTransaction(JSON.parse(decoder.decode(bytes)), environment)
}

type ValidatedHookTransaction = {
  journal: HookTransaction
  bytes: Uint8Array
  currentHash: string
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

async function validateHookTransaction(
  environment: NodeJS.ProcessEnv,
): Promise<ValidatedHookTransaction | undefined> {
  const journal = await readHookTransaction(environment)
  if (journal === undefined) return undefined
  const bytes = Buffer.from(journal.bytes, 'base64')
  if (createHash('sha256').update(bytes).digest('hex') !== journal.afterSha256)
    throw new Error('interrupted hook transaction bytes are corrupt')

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
      throw new Error('interrupted hook transaction ownership does not match provider hooks')
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
  const path = join(configRoot(environment), 'hook-transaction.json')
  const kind = await pathKind(path)
  if (kind === 'missing') return { state: 'absent' }
  if (kind !== 'file') return { state: 'invalid', error: 'installation transaction is unsafe' }
  try {
    await validateHookTransaction(environment)
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
  const journalPath = join(root, 'hook-transaction.json')
  const before = (await readProviderConfig(path)) ?? encoder.encode('{}\n')
  const expectedBefore = expected ?? encoder.encode('{}\n')
  if (!Buffer.from(before).equals(expectedBefore))
    throw new Error('provider hooks changed while Factory prepared its patch')
  const journal = {
    schemaVersion: 1,
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

export async function recoverHookTransaction(environment: NodeJS.ProcessEnv): Promise<void> {
  const root = configRoot(environment)
  const path = join(root, 'hook-transaction.json')
  const validated = await validateHookTransaction(environment)
  if (validated === undefined) return
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

export async function installHooks(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<HookState> {
  if (!isAbsolute(executable) || (await pathKind(executable)) !== 'file')
    throw new Error('Factory hook executable must be an existing absolute ordinary file')
  await access(executable, constants.X_OK).catch(() => {
    throw new Error('Factory hook executable must be executable')
  })
  await recoverHookTransaction(environment)
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

export async function uninstallHooks(environment: NodeJS.ProcessEnv): Promise<void> {
  await recoverHookTransaction(environment)
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
