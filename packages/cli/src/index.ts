import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  link,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import {
  claudeCaptureAdapter,
  codexCaptureAdapter,
  createCaptureAdapter,
  materializeLifecycle,
  materializeStop,
  reduceRepository,
  removeOwnedHooks,
  resolveConfiguration,
  suggestCanonicalBranch,
  verifyLifecycleCompletion,
  verifyTurnCompletion,
  type GlobalFactoryConfig,
} from '@factory/capture'
import {
  FACTORY_READER_VERSION,
  canonicalJson,
  newRecordId,
  type JsonValue,
  type RepositoryId,
} from '@factory/contract'
import {
  initializeRepositoryStore,
  openRepositoryStore,
  withAdvisoryFileLock,
  type RepositoryStore,
} from '@factory/repository'
import {
  openRuntimeJournal,
  type CaptureProvider,
  type RuntimeJournal,
} from '@factory/runtime-journal'

import { reviewCommand } from './review'

type Output = { stdout(value: string): void; stderr(value: string): void }
type OwnedFingerprint = { event: string; fingerprint: string }
type HookState = {
  schemaVersion: 1
  executable: string
  providers: Partial<
    Record<CaptureProvider, { path: string; fingerprints: readonly OwnedFingerprint[] }>
  >
}
type SessionOwner = {
  provider: CaptureProvider
  sessionId: string
  generation: number
  repositoryRoot: string
  repositoryId: RepositoryId
  firstObservedAt: string
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

function configRoot(environment: NodeJS.ProcessEnv): string {
  return join(
    environment.XDG_CONFIG_HOME ?? join(environment.HOME ?? homedir(), '.config'),
    'factory',
  )
}

function stateRoot(environment: NodeJS.ProcessEnv): string {
  return join(
    environment.XDG_STATE_HOME ?? join(environment.HOME ?? homedir(), '.local', 'state'),
    'factory',
  )
}

async function pathKind(path: string): Promise<'missing' | 'file' | 'directory' | 'symlink'> {
  try {
    const value = await lstat(path)
    if (value.isSymbolicLink()) return 'symlink'
    if (value.isFile()) return 'file'
    if (value.isDirectory()) return 'directory'
    throw new Error(`unsupported filesystem entry: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicPrivateWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if ((await pathKind(path)) === 'symlink')
    throw new Error(`Factory refuses symbolic link: ${path}`)
  const temporary = `${path}.factory-${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
  const handle = await open(temporary, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
  await syncDirectory(dirname(path))
}

async function readJsonObject(path: string): Promise<Record<string, JsonValue>> {
  if ((await pathKind(path)) === 'missing') return {}
  if ((await pathKind(path)) !== 'file')
    throw new Error(`Factory requires an ordinary file: ${path}`)
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError(`${path} must contain a JSON object`)
  }
  return value as Record<string, JsonValue>
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: {
      PATH: environment.PATH ?? '/usr/bin:/bin',
      HOME: environment.HOME,
      XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [code, stdoutBytes, stderrBytes] = await Promise.race([
      Promise.all([
        child.exited,
        readBoundedStream(child.stdout, 1024 * 1024),
        readBoundedStream(child.stderr, 1024 * 1024),
      ]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${command} timed out`)), 5_000)
      }),
    ])
    return {
      code,
      stdout: textDecoder.decode(stdoutBytes),
      stderr: textDecoder.decode(stderrBytes),
    }
  } catch (error) {
    child.kill(9)
    await child.exited.catch(() => undefined)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.byteLength
    if (total > maximumBytes) throw new Error('input exceeds its byte bound')
    chunks.push(chunk.slice())
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

async function gitRoot(cwd: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const result = await run('git', ['rev-parse', '--show-toplevel'], cwd, environment)
  if (result.code !== 0) return undefined
  return await realpath(result.stdout.trim())
}

async function gitCommonRoot(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const result = await run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    repositoryRoot,
    environment,
  )
  return result.code === 0 ? await realpath(result.stdout.trim()) : undefined
}

async function readRoutedProof(
  reference: {
    path: Parameters<RepositoryStore['readImmutable']>[0]
    sha256: string
    repositoryRoot: string
    repositoryId: string
  },
  anchorRoot: string,
  anchorRepositoryId: string,
  environment: NodeJS.ProcessEnv,
): Promise<Uint8Array> {
  if (
    reference.repositoryId !== anchorRepositoryId ||
    (await gitCommonRoot(reference.repositoryRoot, environment)) !==
      (await gitCommonRoot(anchorRoot, environment))
  ) {
    throw new Error('runtime completion proof is outside its repository authority')
  }
  const routed = await openRepositoryStore(reference.repositoryRoot)
  if (routed.manifest.repositoryId !== anchorRepositoryId) {
    throw new Error('runtime completion proof repository identity is inconsistent')
  }
  return await routed.readImmutable(reference.path, reference.sha256)
}

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function boolOption(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new TypeError('boolean options must be true or false')
}

async function globalConfig(environment: NodeJS.ProcessEnv): Promise<GlobalFactoryConfig> {
  const value = await readJsonObject(join(configRoot(environment), 'config.json'))
  if (
    value.repositoryInitialization !== undefined &&
    value.repositoryInitialization !== 'explicit' &&
    value.repositoryInitialization !== 'automatic'
  ) {
    throw new TypeError('repositoryInitialization is unsupported')
  }
  if (value.automaticReview !== undefined && typeof value.automaticReview !== 'boolean') {
    throw new TypeError('automaticReview must be boolean')
  }
  if (
    value.canonicalBranch !== undefined &&
    (typeof value.canonicalBranch !== 'string' || value.canonicalBranch.trim() === '')
  ) {
    throw new TypeError('canonicalBranch must be a nonblank string')
  }
  if (
    value.reviewer !== undefined &&
    value.reviewer !== 'auto' &&
    (value.reviewer === null ||
      Array.isArray(value.reviewer) ||
      typeof value.reviewer !== 'object' ||
      (value.reviewer.provider !== 'codex' && value.reviewer.provider !== 'claude'))
  ) {
    throw new TypeError('reviewer is unsupported')
  }
  return value as GlobalFactoryConfig
}

async function canonicalSuggestion(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  explicit?: string,
) {
  return await suggestCanonicalBranch(
    {
      gh: async () => {
        const auth = await run('gh', ['auth', 'status'], repositoryRoot, environment).catch(
          () => undefined,
        )
        if (auth?.code !== 0) return undefined
        const result = await run(
          'gh',
          ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
          repositoryRoot,
          environment,
        ).catch(() => undefined)
        return result?.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined
      },
      remoteHead: async () => {
        const result = await run(
          'git',
          ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'],
          repositoryRoot,
          environment,
        )
        return result.code === 0 ? result.stdout.trim().replace(/^[^/]+\//, '') : undefined
      },
      localBranches: async () => {
        const result = await run(
          'git',
          ['for-each-ref', '--format=%(refname:short)', 'refs/heads/main', 'refs/heads/master'],
          repositoryRoot,
          environment,
        )
        return result.code === 0 ? result.stdout.trim().split('\n').filter(Boolean) : []
      },
    },
    explicit,
  )
}

async function initialize(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  explicitBranch?: string,
): Promise<RepositoryStore> {
  if ((await pathKind(join(repositoryRoot, '.factory', 'manifest.json'))) === 'file') {
    const existing = await openRepositoryStore(repositoryRoot)
    if (explicitBranch !== undefined)
      await existing.updateConfig({ canonicalBranch: explicitBranch })
    return existing
  }
  const suggestion = await canonicalSuggestion(repositoryRoot, environment, explicitBranch)
  if (suggestion === undefined) {
    throw new Error('Canonical branch is unavailable; pass --canonical-branch')
  }
  const createdAt = new Date().toISOString()
  const repositoryId = `repo_${newRecordId('repository').split('_')[1]}` as RepositoryId
  return await initializeRepositoryStore(
    repositoryRoot,
    {
      schemaVersion: 1,
      format: 'factory-repository',
      minimumReaderVersion: FACTORY_READER_VERSION,
      repositoryId,
      createdAt,
    },
    { canonicalBranch: suggestion.branch },
  )
}

function providerPath(provider: CaptureProvider, environment: NodeJS.ProcessEnv): string {
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

async function readHookState(environment: NodeJS.ProcessEnv): Promise<HookState | undefined> {
  const path = join(configRoot(environment), 'hooks-state.json')
  if ((await pathKind(path)) === 'missing') return undefined
  const bytes = await readFile(path)
  if (bytes.byteLength > 1024 * 1024) throw new Error('Factory hook state exceeds its size bound')
  const state = JSON.parse(textDecoder.decode(bytes)) as HookState
  if (
    state.schemaVersion !== 1 ||
    !isAbsolute(state.executable) ||
    typeof state.providers !== 'object'
  ) {
    throw new Error('Factory hook state is invalid')
  }
  for (const provider of ['codex', 'claude'] as const) {
    const owned = state.providers[provider]
    if (owned === undefined) continue
    if (owned.path !== providerPath(provider, environment) || !Array.isArray(owned.fingerprints)) {
      throw new Error('Factory hook state is invalid')
    }
  }
  return state
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
  const before =
    (await pathKind(path)) === 'file' ? await readFile(path) : textEncoder.encode('{}\n')
  const expectedBefore = expected ?? textEncoder.encode('{}\n')
  if (!Buffer.from(before).equals(expectedBefore)) {
    throw new Error('provider hooks changed while Factory prepared its patch')
  }
  const journal = {
    schemaVersion: 1,
    provider,
    path,
    beforeSha256: createHash('sha256').update(before).digest('hex'),
    afterSha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: Buffer.from(bytes).toString('base64'),
    nextState,
  }
  await atomicPrivateWrite(journalPath, textEncoder.encode(canonicalJson(journal)))
  if (process.env.FACTORY_TEST_HOOK_CRASH === 'after-journal') throw new Error('injected crash')
  const prewrite =
    (await pathKind(path)) === 'file' ? await readFile(path) : textEncoder.encode('{}\n')
  if (!Buffer.from(prewrite).equals(expectedBefore)) {
    await unlink(journalPath)
    await syncDirectory(root)
    throw new Error('provider hooks changed while Factory prepared its patch')
  }
  await atomicPrivateWrite(path, bytes)
  if (process.env.FACTORY_TEST_HOOK_CRASH === 'after-config') throw new Error('injected crash')
  await atomicPrivateWrite(
    join(root, 'hooks-state.json'),
    textEncoder.encode(canonicalJson(nextState)),
  )
  await unlink(journalPath)
  await syncDirectory(root)
}

async function recoverHookTransaction(environment: NodeJS.ProcessEnv): Promise<void> {
  const root = configRoot(environment)
  const path = join(root, 'hook-transaction.json')
  if ((await pathKind(path)) === 'missing') return
  const journalBytes = await readFile(path)
  if (journalBytes.byteLength > 2 * 1024 * 1024)
    throw new Error('interrupted hook transaction exceeds its size bound')
  const journal = JSON.parse(textDecoder.decode(journalBytes)) as {
    provider: CaptureProvider
    path: string
    beforeSha256: string
    afterSha256: string
    bytes: string
    nextState: HookState
  }
  if (journal.path !== providerPath(journal.provider, environment)) {
    throw new Error('interrupted hook transaction targets an unexpected provider path')
  }
  const bytes = Buffer.from(journal.bytes, 'base64')
  if (createHash('sha256').update(bytes).digest('hex') !== journal.afterSha256) {
    throw new Error('interrupted hook transaction bytes are corrupt')
  }
  const current =
    (await pathKind(journal.path)) === 'file'
      ? await readFile(journal.path)
      : textEncoder.encode('{}\n')
  const hash = createHash('sha256').update(current).digest('hex')
  if (hash === journal.beforeSha256) {
    await unlink(path)
    await syncDirectory(root)
    return
  }
  if (hash !== journal.afterSha256) {
    throw new Error('provider hooks changed during interrupted Factory transaction')
  }
  await atomicPrivateWrite(
    join(root, 'hooks-state.json'),
    textEncoder.encode(canonicalJson(journal.nextState)),
  )
  await unlink(path)
  await syncDirectory(root)
}

async function installHooks(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<HookState> {
  if (!isAbsolute(executable) || (await pathKind(executable)) !== 'file') {
    throw new Error('Factory hook executable must be an existing absolute ordinary file')
  }
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
    const existing = (await pathKind(path)) === 'file' ? await readFile(path) : undefined
    const adapter = createCaptureAdapter(provider, state.providers[provider]?.fingerprints)
    const patch = adapter.reconcileHooks(existing, executable)
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

async function uninstallHooks(environment: NodeJS.ProcessEnv): Promise<void> {
  await recoverHookTransaction(environment)
  let state = await readHookState(environment)
  if (state === undefined) return
  for (const provider of ['codex', 'claude'] as const) {
    const owned = state.providers[provider]
    if (owned === undefined) continue
    if (owned.path !== providerPath(provider, environment)) {
      throw new Error('Factory hook ownership state targets an unexpected provider path')
    }
    const existing =
      (await pathKind(owned.path)) === 'file' ? await readFile(owned.path) : undefined
    const providers: HookState['providers'] = { ...state.providers }
    delete providers[provider]
    state = { ...state, providers }
    if (existing === undefined) {
      await atomicPrivateWrite(
        join(configRoot(environment), 'hooks-state.json'),
        textEncoder.encode(canonicalJson(state)),
      )
      continue
    }
    const patch = removeOwnedHooks(provider, existing, owned.fingerprints)
    await applyHookPatch(provider, owned.path, existing, patch.bytes, state, environment)
  }
}

function ownerKey(provider: CaptureProvider, sessionId: string, generation: number): string {
  return createHash('sha256').update(`${provider}\0${sessionId}\0${generation}`).digest('hex')
}

function parseOwner(bytes: Uint8Array, key: string): SessionOwner {
  if (bytes.byteLength > 16 * 1024) throw new Error('Session owner record exceeds its size bound')
  const owner = JSON.parse(textDecoder.decode(bytes)) as SessionOwner
  if (
    (owner.provider !== 'codex' && owner.provider !== 'claude') ||
    typeof owner.sessionId !== 'string' ||
    !Number.isSafeInteger(owner.generation) ||
    owner.generation < 0 ||
    !isAbsolute(owner.repositoryRoot) ||
    typeof owner.repositoryId !== 'string' ||
    typeof owner.firstObservedAt !== 'string' ||
    ownerKey(owner.provider, owner.sessionId, owner.generation) !== key
  )
    throw new Error('invalid Session owner record')
  return owner
}

async function readOwner(
  environment: NodeJS.ProcessEnv,
  key: string,
): Promise<SessionOwner | undefined> {
  const path = join(stateRoot(environment), 'session-owners', `${key}.json`)
  if ((await pathKind(path)) === 'missing') return undefined
  return parseOwner(await readFile(path), key)
}

async function claimOwner(
  environment: NodeJS.ProcessEnv,
  key: string,
  owner: SessionOwner,
): Promise<SessionOwner> {
  const root = join(stateRoot(environment), 'session-owners')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, `${key}.json`)
  const temporary = join(root, `.owner-${randomUUID()}.tmp`)
  const bytes = textEncoder.encode(canonicalJson(owner))
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
  const handle = await open(temporary, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    try {
      await link(temporary, path)
      await syncDirectory(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  return parseOwner(await readFile(path), key)
}

async function recoverRepository(
  repositoryRoot: string,
  store: RepositoryStore,
  repositoryStores: Map<string, RepositoryStore>,
  journal: RuntimeJournal,
  environment: NodeJS.ProcessEnv,
) {
  const common = await run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    repositoryRoot,
    environment,
  )
  if (common.code !== 0) throw new Error('Factory cannot locate the Git-common capture fence')
  const fencePath = join(common.stdout.trim(), 'factory-runtime', 'capture.lock')
  await withAdvisoryFileLock(fencePath, 50, async () => {
    for await (const work of journal.recover()) {
      if (work.availability !== 'ready') continue
      try {
        const owner = await readOwner(
          environment,
          ownerKey(work.stop.provider, work.stop.sessionId, work.stop.generation),
        )
        if (
          owner === undefined ||
          owner.repositoryId !== store.manifest.repositoryId ||
          (await gitCommonRoot(owner.repositoryRoot, environment)) !==
            (await gitCommonRoot(repositoryRoot, environment))
        )
          continue
        const claim = work.claim ?? (await journal.claimStop(work.stop)).claim
        const providerHome =
          owner.provider === 'codex'
            ? (environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), '.codex'))
            : (environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? homedir(), '.claude'))
        const ownerCommon = await gitCommonRoot(owner.repositoryRoot, environment)
        const sameRepositoryWorktrees: string[] = []
        for (const path of new Set(work.events.flatMap(event => event.worktreePath ?? []))) {
          if (
            ownerCommon !== undefined &&
            (await gitCommonRoot(path, environment)) === ownerCommon
          ) {
            try {
              const candidateStore = await openRepositoryStore(path)
              if (candidateStore.manifest.repositoryId === owner.repositoryId) {
                sameRepositoryWorktrees.push(path)
                repositoryStores.set(path, candidateStore)
              }
            } catch {
              // A linked checkout without the portable Factory repository stays pending.
            }
          }
        }
        const stopWorktree = work.events.at(-1)?.worktreePath
        if (
          stopWorktree !== undefined &&
          (await gitCommonRoot(stopWorktree, environment)) === ownerCommon &&
          !sameRepositoryWorktrees.includes(stopWorktree)
        ) {
          throw new Error('linked worktree does not expose the owning Factory repository')
        }
        const targetRoot =
          stopWorktree !== undefined && sameRepositoryWorktrees.includes(stopWorktree)
            ? stopWorktree
            : owner.repositoryRoot
        const targetStore = repositoryStores.get(targetRoot) ?? store
        await materializeStop({
          repositoryRoot: targetRoot,
          sameRepositoryWorktrees,
          store: targetStore,
          journal,
          claim,
          sessionFirstObservedAt: owner.firstObservedAt,
          providerHome,
        })
      } catch (error) {
        await journal.recordDiagnostic(error)
      }
    }
    for await (const lifecycle of journal.recoverLifecycle()) {
      try {
        const owner = await readOwner(
          environment,
          ownerKey(lifecycle.provider, lifecycle.sessionId, lifecycle.generation),
        )
        if (
          owner === undefined ||
          owner.repositoryId !== store.manifest.repositoryId ||
          (await gitCommonRoot(owner.repositoryRoot, environment)) !==
            (await gitCommonRoot(repositoryRoot, environment))
        )
          continue
        let candidates = [...repositoryStores.values()]
        if (lifecycle.worktreePath !== undefined) {
          const ownerCommon = await gitCommonRoot(owner.repositoryRoot, environment)
          const lifecycleCommon = await gitCommonRoot(lifecycle.worktreePath, environment)
          if (ownerCommon !== undefined && lifecycleCommon === ownerCommon) {
            let lifecycleStore = repositoryStores.get(lifecycle.worktreePath)
            if (lifecycleStore === undefined) {
              lifecycleStore = await openRepositoryStore(lifecycle.worktreePath)
              if (lifecycleStore.manifest.repositoryId !== owner.repositoryId) {
                throw new Error('linked worktree does not expose the owning Factory repository')
              }
              repositoryStores.set(lifecycle.worktreePath, lifecycleStore)
            }
            candidates = [lifecycleStore]
          }
        }
        for (const candidate of candidates) {
          if ((await materializeLifecycle(lifecycle, journal, candidate)) === 'materialized') break
        }
      } catch (error) {
        await journal.recordDiagnostic(error)
      }
    }
  })
}

async function capture(
  provider: CaptureProvider,
  environment: NodeJS.ProcessEnv,
): Promise<'stored' | 'ignored' | 'failed'> {
  const raw = await readBoundedStream(Bun.stdin.stream(), 64 * 1024 * 1024)
  const adapter = provider === 'codex' ? codexCaptureAdapter : claudeCaptureAdapter
  let envelope
  try {
    envelope = adapter.classify(raw)
  } catch {
    return 'failed'
  }
  const key = ownerKey(provider, envelope.nativeSessionId, envelope.generation)
  const existingOwner = await readOwner(environment, key)
  const currentRoot = await gitRoot(envelope.worktreePath ?? process.cwd(), environment)
  if (existingOwner === undefined && currentRoot === undefined) return 'ignored'
  if (existingOwner === undefined) {
    const initialized = (await pathKind(join(currentRoot!, '.factory', 'manifest.json'))) === 'file'
    if (!initialized) {
      const global = await globalConfig(environment)
      if (global.repositoryInitialization !== 'automatic') return 'ignored'
      await initialize(currentRoot!, environment, global.canonicalBranch)
    }
  }
  const owner =
    existingOwner ??
    (await (async () => {
      const currentStore = await openRepositoryStore(currentRoot!)
      return await claimOwner(environment, key, {
        provider,
        sessionId: envelope.nativeSessionId,
        generation: envelope.generation,
        repositoryRoot: currentRoot!,
        repositoryId: currentStore.manifest.repositoryId,
        firstObservedAt: envelope.occurredAt,
      })
    })())
  const store = await openRepositoryStore(owner.repositoryRoot)
  if (
    owner.provider !== provider ||
    owner.sessionId !== envelope.nativeSessionId ||
    owner.generation !== envelope.generation ||
    owner.repositoryId !== store.manifest.repositoryId
  ) {
    throw new Error('Session owner state does not match the capture or repository')
  }
  const repositoryStores = new Map([[owner.repositoryRoot, store]])
  if (
    currentRoot !== undefined &&
    currentRoot !== owner.repositoryRoot &&
    (await gitCommonRoot(currentRoot, environment)) ===
      (await gitCommonRoot(owner.repositoryRoot, environment))
  ) {
    try {
      const currentStore = await openRepositoryStore(currentRoot)
      if (currentStore.manifest.repositoryId === owner.repositoryId) {
        repositoryStores.set(currentRoot, currentStore)
      }
    } catch {
      // Recovery will preserve the claim and diagnose a linked checkout without Factory data.
    }
  }
  const journal = await openRuntimeJournal({
    repositoryRoot: owner.repositoryRoot,
    verifyTurn: async (claim, turn) => {
      const bytes = await readRoutedProof(
        turn,
        owner.repositoryRoot,
        owner.repositoryId,
        environment,
      )
      verifyTurnCompletion(claim, turn, bytes)
      return bytes
    },
    verifyLifecycle: async (event, record) => {
      const bytes = await readRoutedProof(
        record,
        owner.repositoryRoot,
        owner.repositoryId,
        environment,
      )
      verifyLifecycleCompletion(event, record, bytes)
      return bytes
    },
  })
  try {
    const appended = await journal.appendNonBlocking({
      provider,
      sessionId: envelope.nativeSessionId,
      generation: envelope.generation,
      eventId: envelope.eventId,
      eventKind: envelope.eventKind,
      occurredAt: envelope.occurredAt,
      raw,
      ...(envelope.stopId === undefined ? {} : { stopId: envelope.stopId }),
      ...(currentRoot === undefined ? {} : { worktreePath: currentRoot }),
    })
    if (appended.receipt === undefined) return 'failed'
    await recoverRepository(owner.repositoryRoot, store, repositoryStores, journal, environment)
    return 'stored'
  } finally {
    await journal.close()
  }
}

async function doctor(
  repositoryRoot: string,
  repair: boolean,
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, JsonValue>> {
  if (repair) await recoverHookTransaction(environment)
  const store = await openRepositoryStore(repositoryRoot)
  const verification = await store.verify()
  const config = await store.readConfig()
  const suggestion = await canonicalSuggestion(repositoryRoot, environment)
  let pendingStops: number | null = null
  let pendingLifecycle: number | null = null
  const gitCommon = await run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    repositoryRoot,
    environment,
  )
  const journalPath =
    gitCommon.code === 0
      ? join(gitCommon.stdout.trim(), 'factory-runtime', 'journal-v1', 'journal.sqlite')
      : undefined
  if (!repair && journalPath !== undefined && (await pathKind(journalPath)) === 'file') {
    const database = new Database(journalPath, { readonly: true })
    try {
      pendingStops = Number(
        (
          database
            .query(
              `SELECT (SELECT COUNT(*) FROM events WHERE event_kind='stop') - (SELECT COUNT(*) FROM completions) AS count`,
            )
            .get() as { count: number }
        ).count,
      )
      pendingLifecycle = Number(
        (
          database
            .query(
              `SELECT COUNT(*) AS count FROM events e LEFT JOIN lifecycle_completions l ON l.event_key=e.event_key WHERE e.event_kind='session-end' AND l.event_key IS NULL`,
            )
            .get() as { count: number }
        ).count,
      )
    } finally {
      database.close(false)
    }
  }
  if (repair) {
    const repositoryStores = new Map([[repositoryRoot, store]])
    const journal = await openRuntimeJournal({
      repositoryRoot,
      verifyTurn: async (claim, turn) => {
        const bytes = await readRoutedProof(
          turn,
          repositoryRoot,
          store.manifest.repositoryId,
          environment,
        )
        verifyTurnCompletion(claim, turn, bytes)
        return bytes
      },
      verifyLifecycle: async (event, record) => {
        const bytes = await readRoutedProof(
          record,
          repositoryRoot,
          store.manifest.repositoryId,
          environment,
        )
        verifyLifecycleCompletion(event, record, bytes)
        return bytes
      },
    })
    try {
      await recoverRepository(repositoryRoot, store, repositoryStores, journal, environment)
      pendingStops = (await Array.fromAsync(journal.recover())).length
      pendingLifecycle = (await Array.fromAsync(journal.recoverLifecycle())).length
    } finally {
      await journal.close()
    }
  }
  const records = await store.readRecords()
  const hookState = await readHookState(environment).catch(error => ({
    error: error instanceof Error ? error.message : String(error),
  }))
  const hookTransactionPending =
    (await pathKind(join(configRoot(environment), 'hook-transaction.json'))) === 'file'
  const diagnosticsRoot =
    gitCommon.code === 0
      ? join(gitCommon.stdout.trim(), 'factory-runtime', 'journal-v1', 'diagnostics')
      : undefined
  const captureDiagnostics: string[] = []
  let diagnosticsTruncated = false
  if (diagnosticsRoot !== undefined && (await pathKind(diagnosticsRoot)) === 'directory') {
    const directory = await opendir(diagnosticsRoot)
    let visited = 0
    try {
      for await (const entry of directory) {
        visited += 1
        if (visited > 10_000) {
          diagnosticsTruncated = true
          break
        }
        if (/^[0-9a-f]{64}\.txt$/.test(entry.name)) captureDiagnostics.push(entry.name)
      }
    } finally {
      try {
        await directory.close()
      } catch {
        // Async iteration closes the directory after exhaustion.
      }
    }
  }
  captureDiagnostics.sort()
  if (diagnosticsTruncated) captureDiagnostics.push('inventory-exceeds-bound')
  const projection = reduceRepository(records)
  const issues = [
    ...verification.issues,
    ...projection.issues.map(detail => ({ code: 'incomplete-committed-graph', detail })),
  ]
  return {
    repository: issues.length === 0 ? 'ok' : 'invalid',
    issues: issues as unknown as JsonValue,
    pendingStops,
    pendingLifecycle,
    projection: projection as unknown as JsonValue,
    hooks: (hookState ?? null) as unknown as JsonValue,
    hookTransactionPending,
    captureDiagnostics: captureDiagnostics as unknown as JsonValue,
    canonicalBranch: config.canonicalBranch ?? null,
    observedDefaultBranch: suggestion?.branch ?? null,
    canonicalBranchDrift:
      typeof config.canonicalBranch === 'string' && suggestion !== undefined
        ? config.canonicalBranch !== suggestion.branch
        : false,
    repair,
  }
}

export async function runFactoryCli(
  args: readonly string[],
  options: { environment?: NodeJS.ProcessEnv; cwd?: string; output?: Output } = {},
): Promise<number> {
  const environment = options.environment ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const output =
    options.output ??
    ({
      stdout: value => process.stdout.write(value),
      stderr: value => process.stderr.write(value),
    } satisfies Output)
  const [command] = args
  try {
    if (command === 'configure') {
      if (args.includes('--repo') === args.includes('--global')) {
        throw new Error('factory configure requires exactly one of --repo or --global')
      }
      const target = args.includes('--repo') ? 'repo' : 'global'
      const change: GlobalFactoryConfig = {
        canonicalBranch: readOption(args, '--canonical-branch'),
        automaticReview: boolOption(readOption(args, '--automatic-review')),
      }
      const initialization = readOption(args, '--repository-initialization')
      if (initialization !== undefined) {
        if (target === 'repo') {
          throw new Error('--repository-initialization is global-only')
        }
        if (initialization !== 'explicit' && initialization !== 'automatic') {
          throw new TypeError('repository initialization must be explicit or automatic')
        }
        if (initialization === 'automatic' && !args.includes('--acknowledge-plaintext-evidence')) {
          throw new Error('Automatic init requires --acknowledge-plaintext-evidence')
        }
        change.repositoryInitialization = initialization
      }
      if (target === 'global') {
        const path = join(configRoot(environment), 'config.json')
        const current = await readJsonObject(path)
        const next = Object.fromEntries(
          Object.entries({ ...current, ...change }).filter(([, value]) => value !== undefined),
        )
        await atomicPrivateWrite(path, textEncoder.encode(canonicalJson(next)))
        output.stdout(`${path}\n${canonicalJson(resolveConfiguration({}, {}, next))}`)
      } else {
        const root = await gitRoot(cwd, environment)
        if (root === undefined)
          throw new Error('factory configure --repo requires a Git repository')
        const store = await openRepositoryStore(root)
        const current = await store.readConfig()
        const branch =
          change.canonicalBranch === undefined && current.canonicalBranch !== undefined
            ? undefined
            : await canonicalSuggestion(root, environment, change.canonicalBranch)
        await store.updateConfig({
          ...(branch === undefined ? {} : { canonicalBranch: branch.branch }),
          ...(change.automaticReview === undefined
            ? {}
            : { automaticReview: change.automaticReview }),
        })
        const next = await store.readConfig()
        output.stdout(
          `${join(root, '.factory', 'config.json')}\n${canonicalJson(resolveConfiguration({}, next, await globalConfig(environment)))}`,
        )
      }
      return 0
    }
    if (command === 'init') {
      const root = await gitRoot(cwd, environment)
      if (root === undefined) throw new Error('factory init requires a Git repository')
      output.stderr(
        'Factory stores complete plaintext traces that may contain source, paths, tool output, and secrets.\n',
      )
      const store = await initialize(root, environment, readOption(args, '--canonical-branch'))
      output.stdout(`${store.factoryRoot}\n`)
      return 0
    }
    if (command === 'install') {
      const executable = readOption(args, '--executable') ?? (await realpath(process.argv[1]!))
      const state = await installHooks(executable, environment)
      output.stdout(`${canonicalJson(state)}`)
      return 0
    }
    if (command === 'uninstall') {
      await uninstallHooks(environment)
      output.stdout('Factory hooks removed.\n')
      return 0
    }
    if (command === 'capture') {
      const provider = readOption(args, '--provider')
      if (provider !== 'codex' && provider !== 'claude') throw new Error('--provider is required')
      const adapter = provider === 'codex' ? codexCaptureAdapter : claudeCaptureAdapter
      let result: 'stored' | 'ignored' | 'failed' = 'failed'
      try {
        result = await capture(provider, environment)
      } catch {
        result = 'failed'
      }
      output.stdout(textDecoder.decode(adapter.providerResponse({ status: result })))
      return 0
    }
    if (command === 'doctor') {
      const root = await gitRoot(cwd, environment)
      if (root === undefined) throw new Error('factory doctor requires a Git repository')
      output.stdout(canonicalJson(await doctor(root, args.includes('--repair'), environment)))
      return 0
    }
    if (command === 'review') {
      const root = await gitRoot(cwd, environment)
      if (root === undefined) throw new Error('factory review requires a Git repository')
      return await reviewCommand(root, args, environment, output)
    }
    throw new Error('Usage: factory configure|init|install|uninstall|capture|doctor|review')
  } catch (error) {
    output.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
