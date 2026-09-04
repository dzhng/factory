import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import {
  canonicalJson,
  makeOwnedPath,
  newRecordId,
  type EvidenceEnvelope,
  type JsonValue,
  type LifecycleRecord,
  type Limitation,
  type ObjectRef,
  type OwnedPath,
  type RepositoryId,
  type RepositoryObservation,
  type ReviewTrigger,
  type SessionIdentity,
  type TurnManifest,
} from '@factory/contract'
import {
  GitObserver,
  loadCodeManifestObject,
  readConfinedFile,
  type ImmutableGroupRecord,
  type RepositoryRecords,
  type RepositoryStore,
} from '@factory/repository'
import type {
  CaptureEventKind,
  CaptureProvider,
  DurableCaptureEvent,
  MaterializationClaim,
  TurnRef,
} from '@factory/runtime-journal'
import type { RuntimeJournal } from '@factory/runtime-journal'

export type CaptureEnvelope = {
  provider: CaptureProvider
  nativeSessionId: string
  generation: number
  eventId: string
  nativeEvent: string
  eventKind: CaptureEventKind
  occurredAt: string
  raw: Uint8Array
  stopId?: string
  worktreePath?: string
  transcriptPath?: string
  parsed: Record<string, JsonValue>
}

export type CaptureResult = { status: 'stored' | 'ignored' | 'failed' }

export type HookPatch = {
  bytes: Uint8Array
  ownedFingerprints: readonly { event: string; fingerprint: string }[]
  changed: boolean
}

export interface CaptureAdapter {
  classify(raw: Uint8Array): CaptureEnvelope
  providerResponse(result: CaptureResult): Uint8Array
  reconcileHooks(existing: Uint8Array | undefined, executable: string): HookPatch
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) throw new TypeError(`${key} is required`)
  return field
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string' || field.length === 0)
    throw new TypeError(`${key} must be a string`)
  return field
}

function classify(provider: CaptureProvider, raw: Uint8Array, now: () => Date): CaptureEnvelope {
  const parsed = JSON.parse(decoder.decode(raw)) as unknown
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new TypeError('provider hook payload must be a JSON object')
  }
  const value = parsed as Record<string, JsonValue>
  const nativeEvent = requiredString(value, 'hook_event_name')
  const nativeSessionId = requiredString(value, 'session_id')
  const stopId =
    nativeEvent === 'Stop'
      ? (optionalString(value, provider === 'codex' ? 'turn_id' : 'prompt_id') ??
        `raw-${sha256(raw).slice(0, 32)}`)
      : undefined
  const nativeIdentity =
    optionalString(value, 'event_id') ??
    optionalString(value, 'tool_use_id') ??
    optionalString(value, 'turn_id') ??
    optionalString(value, 'prompt_id') ??
    sha256(raw).slice(0, 32)
  const eventKind: CaptureEventKind =
    nativeEvent === 'SessionStart'
      ? 'session-start'
      : nativeEvent === 'Stop'
        ? 'stop'
        : nativeEvent === 'SessionEnd'
          ? 'session-end'
          : ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact'].includes(
                nativeEvent,
              )
            ? 'turn'
            : 'other'
  return {
    provider,
    nativeSessionId,
    generation: 0,
    eventId: `${nativeEvent}-${nativeIdentity}-${sha256(raw).slice(0, 16)}`,
    nativeEvent,
    eventKind,
    occurredAt: now().toISOString(),
    raw: raw.slice(),
    ...(stopId === undefined ? {} : { stopId }),
    ...(optionalString(value, 'cwd') === undefined
      ? {}
      : { worktreePath: optionalString(value, 'cwd') }),
    ...(optionalString(value, 'transcript_path') === undefined
      ? {}
      : { transcriptPath: optionalString(value, 'transcript_path') }),
    parsed: value,
  }
}

type JsonObject = { [key: string]: unknown }

const CODEX_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const
const CLAUDE_EVENTS = [
  ...CODEX_EVENTS,
  'Setup',
  'InstructionsLoaded',
  'UserPromptExpansion',
  'PermissionDenied',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'TaskCreated',
  'TaskCompleted',
  'StopFailure',
  'TeammateIdle',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'WorktreeCreate',
  'WorktreeRemove',
  'Elicitation',
  'ElicitationResult',
  'MessageDisplay',
  'FileChanged',
] as const

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function hookGroup(provider: CaptureProvider, event: string, executable: string): JsonObject {
  const invocation = `${shellQuote(executable)} capture --provider ${provider}`
  const script = `if [ -x ${shellQuote(executable)} ] && response=$(${invocation} 2>/dev/null); then printf '%s\\n' "$response"; else printf '{}\\n'; fi`
  const command =
    provider === 'codex'
      ? {
          type: 'command',
          command: script,
          timeout: event === 'SessionEnd' ? 3 : 10,
        }
      : {
          type: 'command',
          command: '/bin/sh',
          args: ['-c', script],
          timeout: event === 'SessionEnd' ? 3 : 10,
        }
  return { hooks: [command] }
}

function hookFingerprint(provider: CaptureProvider, event: string, value: unknown): string {
  return sha256(encoder.encode(`${provider}\0${event}\0${JSON.stringify(value)}`))
}

function reconcileHooks(
  provider: CaptureProvider,
  existing: Uint8Array | undefined,
  executable: string,
  priorOwned: ReadonlyMap<string, ReadonlySet<string>>,
): HookPatch {
  if (!executable.startsWith('/')) throw new TypeError('Factory hook executable must be absolute')
  const decoded = existing === undefined ? {} : (JSON.parse(decoder.decode(existing)) as unknown)
  if (decoded === null || Array.isArray(decoded) || typeof decoded !== 'object') {
    throw new TypeError('provider hook configuration must be a JSON object')
  }
  const value = structuredClone(decoded as JsonObject)
  const rawHooks = value.hooks
  if (
    rawHooks !== undefined &&
    (rawHooks === null || Array.isArray(rawHooks) || typeof rawHooks !== 'object')
  ) {
    throw new TypeError('provider hook configuration hooks must be an object')
  }
  const hooks = (rawHooks ?? {}) as JsonObject
  value.hooks = hooks
  const ownedFingerprints: { event: string; fingerprint: string }[] = []
  for (const event of provider === 'codex' ? CODEX_EVENTS : CLAUDE_EVENTS) {
    const rawGroups = hooks[event]
    if (rawGroups !== undefined && !Array.isArray(rawGroups)) {
      throw new TypeError(`provider hook configuration ${event} must be an array`)
    }
    const groups = Array.isArray(rawGroups) ? rawGroups : []
    const desired = hookGroup(provider, event, executable)
    const desiredFingerprint = hookFingerprint(provider, event, desired)
    const authority = new Set(priorOwned.get(event) ?? [])
    const retained = groups.filter(group => !authority.has(hookFingerprint(provider, event, group)))
    retained.push(desired)
    hooks[event] = retained
    ownedFingerprints.push({ event, fingerprint: desiredFingerprint })
  }
  const bytes = encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
  return {
    bytes,
    ownedFingerprints,
    changed: existing === undefined || !Buffer.from(existing).equals(bytes),
  }
}

export function createCaptureAdapter(
  provider: CaptureProvider,
  priorOwned: readonly { event: string; fingerprint: string }[] = [],
): CaptureAdapter {
  const prior = new Map<string, Set<string>>()
  for (const item of priorOwned) {
    const values = prior.get(item.event) ?? new Set<string>()
    values.add(item.fingerprint)
    prior.set(item.event, values)
  }
  return {
    classify: raw => classify(provider, raw, () => new Date()),
    providerResponse: _result => encoder.encode('{}\n'),
    reconcileHooks: (existing, executable) => reconcileHooks(provider, existing, executable, prior),
  }
}

export const codexCaptureAdapter = createCaptureAdapter('codex')
export const claudeCaptureAdapter = createCaptureAdapter('claude')

export function removeOwnedHooks(
  provider: CaptureProvider,
  existing: Uint8Array | undefined,
  owned: readonly { event: string; fingerprint: string }[],
): HookPatch & { foreignEdited: readonly string[] } {
  const decoded = existing === undefined ? {} : (JSON.parse(decoder.decode(existing)) as unknown)
  if (decoded === null || Array.isArray(decoded) || typeof decoded !== 'object') {
    throw new TypeError('provider hook configuration must be a JSON object')
  }
  const value = structuredClone(decoded as JsonObject)
  if (
    value.hooks !== undefined &&
    (value.hooks === null || Array.isArray(value.hooks) || typeof value.hooks !== 'object')
  ) {
    throw new TypeError('provider hook configuration hooks must be an object')
  }
  const hooks = (value.hooks ?? {}) as JsonObject
  value.hooks = hooks
  const byEvent = new Map<string, Set<string>>()
  for (const item of owned) {
    const values = byEvent.get(item.event) ?? new Set<string>()
    values.add(item.fingerprint)
    byEvent.set(item.event, values)
  }
  const foreignEdited: string[] = []
  for (const [event, authority] of byEvent) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new TypeError(`provider hook configuration ${event} must be an array`)
    }
    const groups = Array.isArray(hooks[event]) ? hooks[event] : []
    const retained = groups.filter(group => !authority.has(hookFingerprint(provider, event, group)))
    if (groups.length > 0 && retained.length === groups.length) foreignEdited.push(event)
    hooks[event] = retained
  }
  const bytes = encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
  return {
    bytes,
    changed: existing === undefined || !Buffer.from(existing).equals(bytes),
    ownedFingerprints: [],
    foreignEdited,
  }
}

export type StopMaterializationEvent = {
  event: DurableCaptureEvent
  raw: ObjectRef
  parsed?: JsonValue
}

export type TranscriptObservation = {
  observedAt: string
  raw: ObjectRef
  parsed?: JsonValue
}

export type StopMaterializationInput = {
  repositoryId: RepositoryId
  claim: MaterializationClaim
  events: readonly StopMaterializationEvent[]
  observation: RepositoryObservation
  transcript: readonly TranscriptObservation[]
  materializedAt: string
  adapterVersion: string
  /** Frozen by the first repository ownership observation and reused for every Turn. */
  sessionFirstObservedAt: string
  limitations?: readonly Limitation[]
  codeObjects?: readonly ObjectRef[]
}

export type TurnWritePlan = {
  claim: MaterializationClaim
  sessionKey: string
  turn: TurnRef
  triggerPath: OwnedPath
  records: readonly ImmutableGroupRecord[]
}

export type PlanRefusal = {
  reason: 'repository-mismatch' | 'claim-events-mismatch' | 'empty-claim' | 'record-limit'
  detail: string
}

function deterministicRecordId(prefix: string, seed: string, timestamp: string) {
  const entropy = createHash('sha256').update(seed).digest().subarray(0, 10)
  return newRecordId(prefix, new Date(timestamp).getTime(), entropy)
}

function materializationIdentity(claim: MaterializationClaim) {
  const seed = canonicalJson({ claimId: claim.claimId, stop: claim.stop })
  const sessionKey = `${claim.stop.provider}-${sha256(encoder.encode(`${claim.stop.sessionId}\0${claim.stop.generation}`)).slice(0, 32)}`
  const turnId = deterministicRecordId('turn', seed, claim.claimedAt)
  const triggerId = deterministicRecordId('trigger', `${seed}\0trigger`, claim.claimedAt)
  const observationId = deterministicRecordId(
    'observation',
    `${claim.claimId}\0observation`,
    claim.claimedAt,
  )
  return { seed, sessionKey, turnId, triggerId, observationId }
}

function uniqueRefs(refs: readonly ObjectRef[]): ObjectRef[] {
  const values = new Map<string, ObjectRef>()
  for (const ref of refs) values.set(`${ref.sha256}\0${ref.role}\0${ref.mediaType}`, ref)
  return [...values.values()].sort((left, right) => left.sha256.localeCompare(right.sha256))
}

/** Purely derive every public byte and path from the frozen Stop claim. */
export function planTurn(input: StopMaterializationInput): TurnWritePlan | PlanRefusal {
  if (input.events.length === 0) return { reason: 'empty-claim', detail: 'claim has no events' }
  if (input.observation.repositoryId !== input.repositoryId) {
    return {
      reason: 'repository-mismatch',
      detail: 'repository observation does not belong to the Session owner',
    }
  }
  const eventKeys = input.events.map(({ event }) => event.eventKey)
  if (
    eventKeys.length !== input.claim.eventKeys.length ||
    eventKeys.some((key, index) => key !== input.claim.eventKeys[index]) ||
    input.events.at(-1)?.event.sequence !== input.claim.throughSequence
  ) {
    return { reason: 'claim-events-mismatch', detail: 'events do not match the frozen claim' }
  }
  const stopEvent = input.events.at(-1)!.event
  for (let index = 0; index < input.events.length; index += 1) {
    const item = input.events[index]!
    if (
      item.event.provider !== input.claim.stop.provider ||
      item.event.sessionId !== input.claim.stop.sessionId ||
      item.event.generation !== input.claim.stop.generation ||
      item.event.sequence !== input.events[0]!.event.sequence + index ||
      item.raw.sha256 !== item.event.rawSha256 ||
      item.raw.bytes !== item.event.byteLength
    ) {
      return { reason: 'claim-events-mismatch', detail: 'claim event metadata is inconsistent' }
    }
  }
  if (
    stopEvent.eventKind !== 'stop' ||
    stopEvent.stopId !== input.claim.stop.stopId ||
    stopEvent.provider !== input.claim.stop.provider ||
    stopEvent.sessionId !== input.claim.stop.sessionId ||
    stopEvent.generation !== input.claim.stop.generation
  ) {
    return {
      reason: 'claim-events-mismatch',
      detail: 'terminal event does not match the Stop claim',
    }
  }
  const { sessionKey, turnId, triggerId } = materializationIdentity(input.claim)
  const rawObjects = input.events.map(event => event.raw)
  const transcriptObjects = input.transcript.map(item => item.raw)
  const inventory = uniqueRefs([
    ...rawObjects,
    ...transcriptObjects,
    ...(input.observation.codeManifest === undefined ? [] : [input.observation.codeManifest]),
    ...(input.observation.stagedPatch === undefined ? [] : [input.observation.stagedPatch]),
    ...(input.observation.unstagedPatch === undefined ? [] : [input.observation.unstagedPatch]),
    ...(input.codeObjects ?? []),
  ])
  const limitations = [...input.observation.limitations, ...(input.limitations ?? [])]
  const identity: SessionIdentity = {
    schemaVersion: 1,
    provider: input.claim.stop.provider,
    nativeSessionId: input.claim.stop.sessionId,
    sessionKey,
    captureGeneration: input.claim.stop.generation,
    repositoryId: input.repositoryId,
    firstObservedAt: input.sessionFirstObservedAt,
  }
  const eventEnvelopes: EvidenceEnvelope[] = input.events.map(item => ({
    sequence: item.event.sequence,
    observedAt: item.event.occurredAt,
    raw: item.raw,
    ...(item.parsed === undefined ? {} : { parsed: item.parsed }),
  }))
  const transcriptEnvelopes: EvidenceEnvelope[] = input.transcript.map((item, sequence) => ({
    sequence,
    observedAt: item.observedAt,
    raw: item.raw,
    ...(item.parsed === undefined ? {} : { parsed: item.parsed }),
  }))
  const turn: TurnManifest = {
    schemaVersion: 1,
    turnId,
    sessionKey,
    nativeStopId: input.claim.stop.stopId,
    capturedAt: input.events.at(-1)!.event.occurredAt,
    materializedAt: input.materializedAt,
    eventRange: {
      first: input.events[0]!.event.sequence,
      last: input.claim.throughSequence,
    },
    transcriptObservations: transcriptObjects,
    rawObjects,
    repositoryObservationId: input.observation.observationId,
    ...(input.observation.git.branch === undefined ? {} : { branch: input.observation.git.branch }),
    ...(input.observation.codeManifest === undefined
      ? {}
      : { codeManifest: input.observation.codeManifest }),
    ...(input.observation.stagedPatch === undefined
      ? {}
      : { stagedPatch: input.observation.stagedPatch }),
    ...(input.observation.unstagedPatch === undefined
      ? {}
      : { unstagedPatch: input.observation.unstagedPatch }),
    limitations,
    captureAdapterVersion: input.adapterVersion,
    formatVersion: 1,
    inventory,
  }
  const trigger: ReviewTrigger = {
    schemaVersion: 1,
    triggerId,
    sessionKey,
    turnId,
    repositoryObservationId: input.observation.observationId,
    evidenceWatermark: input.claim.throughSequence,
    provider: input.claim.stop.provider,
    createdAt: input.materializedAt,
    materialization: limitations.length === 0 ? 'complete' : 'partial',
    limitations,
  }
  const base = ['sessions', input.claim.stop.provider, sessionKey, 'turns', turnId] as const
  const records: ImmutableGroupRecord[] = [
    {
      path: makeOwnedPath('sessions', [input.claim.stop.provider, sessionKey, 'identity.json']),
      bytes: encoder.encode(canonicalJson(identity)),
    },
    {
      path: makeOwnedPath('sessions', [...base.slice(1), 'events.jsonl']),
      bytes: encoder.encode(eventEnvelopes.map(value => canonicalJson(value)).join('')),
    },
    {
      path: makeOwnedPath('sessions', [...base.slice(1), 'transcript.jsonl']),
      bytes: encoder.encode(transcriptEnvelopes.map(value => canonicalJson(value)).join('')),
    },
    {
      path: makeOwnedPath('repository-observations', [`${input.observation.observationId}.json`]),
      bytes: encoder.encode(canonicalJson(input.observation)),
    },
    {
      path: makeOwnedPath('sessions', [...base.slice(1), 'manifest.json']),
      bytes: encoder.encode(canonicalJson(turn)),
    },
  ]
  const triggerPath = makeOwnedPath('review-triggers', [`${triggerId}.json`])
  records.push({ path: triggerPath, bytes: encoder.encode(canonicalJson(trigger)) })
  if (records.some(record => record.bytes.byteLength > 4 * 1024 * 1024)) {
    return { reason: 'record-limit', detail: 'planned structured record exceeds its read bound' }
  }
  const turnPath = makeOwnedPath('sessions', [
    input.claim.stop.provider,
    sessionKey,
    'turns',
    turnId,
    'manifest.json',
  ])
  return {
    claim: input.claim,
    sessionKey,
    turn: { path: turnPath, sha256: sha256(records[4]!.bytes) },
    triggerPath,
    records,
  }
}

type TurnExecutorStore = Pick<RepositoryStore, 'publishImmutableGroup'>

export async function executeTurn(plan: TurnWritePlan, store: TurnExecutorStore): Promise<TurnRef> {
  await store.publishImmutableGroup(plan.records, plan.triggerPath)
  return plan.turn
}

export type RepositoryProjection = {
  sessions: readonly {
    sessionKey: string
    provider: CaptureProvider
    nativeSessionId: string
    turns: number
    stops: readonly string[]
  }[]
  triggers: number
  issues: readonly string[]
}

/** Fold only Turns that have a matching trigger, the grouped publication commit point. */
export function reduceRepository(records: RepositoryRecords): RepositoryProjection {
  const identities = new Map<string, SessionIdentity>()
  const turns = new Map<string, TurnManifest>()
  const triggers: ReviewTrigger[] = []
  const paths = new Set(records.records.map(record => record.path))
  const observations = new Set<string>()
  const issues: string[] = []
  for (const record of records.records) {
    if (record.path.endsWith('/identity.json')) {
      const value = record.value as SessionIdentity
      identities.set(value.sessionKey, value)
    } else if (record.path.endsWith('/manifest.json') && record.path.startsWith('sessions/')) {
      const value = record.value as unknown as TurnManifest
      turns.set(value.turnId, value)
    } else if (record.path.startsWith('review-triggers/') && record.path.endsWith('.json')) {
      triggers.push(record.value as unknown as ReviewTrigger)
    } else if (
      record.path.startsWith('repository-observations/') &&
      record.path.endsWith('.json')
    ) {
      observations.add((record.value as unknown as RepositoryObservation).observationId)
    }
  }
  const committedTurns = new Set(
    triggers
      .filter(trigger => {
        const turn = turns.get(trigger.turnId)
        const session = identities.get(trigger.sessionKey)
        if (
          turn === undefined ||
          session === undefined ||
          turn.sessionKey !== trigger.sessionKey ||
          turn.repositoryObservationId !== trigger.repositoryObservationId ||
          !observations.has(trigger.repositoryObservationId!)
        ) {
          issues.push(`incomplete committed graph: ${trigger.triggerId}`)
          return false
        }
        const segments = [session.provider, session.sessionKey, 'turns', turn.turnId]
        const complete =
          paths.has(makeOwnedPath('sessions', [...segments, 'events.jsonl'])) &&
          paths.has(makeOwnedPath('sessions', [...segments, 'transcript.jsonl']))
        if (!complete) issues.push(`incomplete committed graph: ${trigger.triggerId}`)
        return complete
      })
      .map(trigger => trigger.turnId),
  )
  const grouped = new Map<string, TurnManifest[]>()
  for (const turn of turns.values()) {
    if (!committedTurns.has(turn.turnId)) continue
    const list = grouped.get(turn.sessionKey) ?? []
    list.push(turn)
    grouped.set(turn.sessionKey, list)
  }
  return {
    sessions: [...grouped]
      .map(([sessionKey, values]) => {
        const identity = identities.get(sessionKey)
        if (identity === undefined)
          throw new Error(`committed Turn lacks Session identity: ${sessionKey}`)
        return {
          sessionKey,
          provider: identity.provider,
          nativeSessionId: identity.nativeSessionId,
          turns: values.length,
          stops: values.map(value => value.nativeStopId).sort(),
        }
      })
      .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
    triggers: committedTurns.size,
    issues: issues.sort(),
  }
}

export type GlobalFactoryConfig = {
  repositoryInitialization?: 'explicit' | 'automatic'
  reviewer?: 'auto' | { provider: CaptureProvider; model?: string; effort?: string }
  automaticReview?: boolean
  canonicalBranch?: string
}

export type EffectiveFactoryConfig = {
  repositoryInitialization: 'explicit' | 'automatic'
  reviewer: NonNullable<GlobalFactoryConfig['reviewer']>
  automaticReview: boolean
  canonicalBranch?: string
}

export function resolveConfiguration(
  flags: GlobalFactoryConfig,
  repository: GlobalFactoryConfig,
  global: GlobalFactoryConfig,
): EffectiveFactoryConfig {
  const merged: EffectiveFactoryConfig = {
    repositoryInitialization: 'explicit' as const,
    reviewer: 'auto' as const,
    automaticReview: false,
  }
  for (const layer of [global, repository, flags]) {
    if (layer.repositoryInitialization !== undefined)
      merged.repositoryInitialization = layer.repositoryInitialization
    if (layer.reviewer !== undefined) merged.reviewer = layer.reviewer
    if (layer.automaticReview !== undefined) merged.automaticReview = layer.automaticReview
    if (layer.canonicalBranch !== undefined) merged.canonicalBranch = layer.canonicalBranch
  }
  return merged
}

export type CanonicalBranchDiscovery = {
  gh(): Promise<string | undefined>
  remoteHead(): Promise<string | undefined>
  localBranches(): Promise<readonly string[]>
}

export type CanonicalBranchSuggestion = {
  branch: string
  source: 'explicit' | 'github' | 'remote-head' | 'local-main' | 'local-master'
}

export async function suggestCanonicalBranch(
  discovery: CanonicalBranchDiscovery,
  explicit?: string,
): Promise<CanonicalBranchSuggestion | undefined> {
  if (explicit !== undefined) return { branch: explicit, source: 'explicit' }
  const github = await discovery.gh()
  if (github !== undefined) return { branch: github, source: 'github' }
  const remote = await discovery.remoteHead()
  if (remote !== undefined) return { branch: remote, source: 'remote-head' }
  const local = await discovery.localBranches()
  if (local.includes('main')) return { branch: 'main', source: 'local-main' }
  if (local.includes('master')) return { branch: 'master', source: 'local-master' }
  return undefined
}

async function hasFactoryConflict(repositoryRoot: string): Promise<boolean> {
  const child = Bun.spawn(
    [
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      'ls-files',
      '-u',
      '-z',
      '--',
      '.factory',
    ],
    {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const bounded = async (stream: ReadableStream<Uint8Array>) => {
    let bytes = 0
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) {
      bytes += chunk.byteLength
      if (bytes > 1024 * 1024) throw new Error('Git conflict output exceeds its bound')
      chunks.push(chunk.slice())
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [exitCode, stdout] = await Promise.race([
      Promise.all([child.exited, bounded(child.stdout), bounded(child.stderr)]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Git conflict inspection timed out')), 5_000)
      }),
    ])
    if (exitCode !== 0) throw new Error('Unable to inspect .factory conflict state')
    return stdout.byteLength > 0
  } catch (error) {
    child.kill(9)
    await child.exited.catch(() => undefined)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function safeTranscript(
  path: string,
  allowedRoot: string,
  maximumBytes = 64 * 1024 * 1024,
): Promise<{ bytes?: Uint8Array; limitation?: Limitation }> {
  try {
    const root = await realpath(allowedRoot)
    const relation = relative(root, resolve(path))
    if (relation === '' || relation.startsWith('..') || relation.startsWith('/')) {
      return {
        limitation: {
          code: 'missing-transcript-range',
          detail: 'provider transcript path is outside its configured home',
        },
      }
    }
    const bytes = await readConfinedFile(
      root,
      relation.split('/').map(segment => Buffer.from(segment)),
      { maximumBytes },
    )
    return { bytes }
  } catch {
    return {
      limitation: {
        code: 'missing-transcript-range',
        detail: 'provider transcript is unavailable or failed safe-path verification',
      },
    }
  }
}

export type MaterializeStopOptions = {
  repositoryRoot: string
  /** Claimed worktree paths proven to share the owner's Git-common repository. */
  sameRepositoryWorktrees?: readonly string[]
  store: RepositoryStore
  journal: RuntimeJournal
  claim: MaterializationClaim
  sessionFirstObservedAt: string
  providerHome: string
  adapterVersion?: string
}

export type MaterializeStopResult =
  | { status: 'materialized'; turn: TurnRef }
  | { status: 'deferred'; reason: 'factory-conflict' | PlanRefusal['reason']; detail: string }

async function materializationLimitations(
  options: MaterializeStopOptions,
  claimed: readonly { event: DurableCaptureEvent; raw: Uint8Array }[],
  observation: RepositoryObservation,
  transcriptBytes: readonly Uint8Array[],
): Promise<Limitation[]> {
  const limitations = [...observation.limitations]
  if (
    claimed.some(
      item =>
        item.event.worktreePath !== undefined &&
        item.event.worktreePath !== options.repositoryRoot &&
        !options.sameRepositoryWorktrees?.includes(item.event.worktreePath),
    )
  ) {
    limitations.push({
      code: 'cross-repository-session',
      detail: 'Session activity was observed outside its owning repository',
    })
  }
  if (observation.limitations.some(limitation => limitation.code === 'repository-race')) {
    limitations.push({
      code: 'repository-race',
      detail: `repository changed from ${observation.startState} to ${observation.endState}`,
    })
  }
  try {
    const stop = JSON.parse(decoder.decode(claimed.at(-1)!.raw)) as Record<string, unknown>
    if (typeof stop.transcript_path !== 'string') {
      if (transcriptBytes.length !== 0)
        throw new Error('Turn has a transcript without a provider transcript path')
      limitations.push({
        code: 'missing-transcript-range',
        detail: 'Stop did not expose a provider transcript path',
      })
      return limitations
    }
    if (transcriptBytes.length > 1)
      throw new Error('Turn has more than one provider transcript observation')
    if (transcriptBytes.length === 1) {
      if (
        typeof stop.last_assistant_message === 'string' &&
        !decoder.decode(transcriptBytes[0]!).includes(stop.last_assistant_message)
      ) {
        limitations.push({
          code: 'missing-transcript-range',
          detail: 'provider transcript lags the Stop assistant message',
        })
      }
      return limitations
    }
    let outside = false
    try {
      const root = await realpath(options.providerHome)
      const relation = relative(root, resolve(stop.transcript_path))
      outside = relation === '' || relation.startsWith('..') || relation.startsWith('/')
    } catch {
      // An unavailable provider root has the same fail-closed result as an unreadable transcript.
    }
    limitations.push({
      code: 'missing-transcript-range',
      detail: outside
        ? 'provider transcript path is outside its configured home'
        : 'provider transcript is unavailable or failed safe-path verification',
    })
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error
    limitations.push({ code: 'corrupt-input', detail: 'Stop payload is not valid JSON' })
  }
  return limitations
}

async function verifyMaterializedTurnGraph(
  options: MaterializeStopOptions,
  claimed: readonly { event: DurableCaptureEvent; raw: Uint8Array }[],
  identity: ReturnType<typeof materializationIdentity>,
  turnPath: OwnedPath,
): Promise<{ bytes: Uint8Array; manifest: TurnManifest }> {
  const bytes = await options.store.readImmutable(turnPath)
  const manifest = JSON.parse(decoder.decode(bytes)) as TurnManifest
  const identityPath = makeOwnedPath('sessions', [
    options.claim.stop.provider,
    identity.sessionKey,
    'identity.json',
  ])
  const base = [options.claim.stop.provider, identity.sessionKey, 'turns', identity.turnId]
  const [identityBytes, eventBytes, transcriptBytes, observationBytes] = await Promise.all([
    options.store.readImmutable(identityPath),
    options.store.readImmutable(makeOwnedPath('sessions', [...base, 'events.jsonl'])),
    options.store.readImmutable(makeOwnedPath('sessions', [...base, 'transcript.jsonl'])),
    options.store.readImmutable(
      makeOwnedPath('repository-observations', [`${manifest.repositoryObservationId!}.json`]),
    ),
  ])
  const session = JSON.parse(decoder.decode(identityBytes)) as SessionIdentity
  const eventEnvelopes = decoder
    .decode(eventBytes)
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as EvidenceEnvelope)
  const transcriptEnvelopes = decoder
    .decode(transcriptBytes)
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as EvidenceEnvelope)
  const observation = JSON.parse(decoder.decode(observationBytes)) as RepositoryObservation
  if (
    session.provider !== options.claim.stop.provider ||
    session.nativeSessionId !== options.claim.stop.sessionId ||
    session.captureGeneration !== options.claim.stop.generation ||
    session.sessionKey !== identity.sessionKey ||
    session.repositoryId !== options.store.manifest.repositoryId ||
    session.firstObservedAt !== options.sessionFirstObservedAt ||
    manifest.turnId !== identity.turnId ||
    manifest.sessionKey !== identity.sessionKey ||
    manifest.nativeStopId !== options.claim.stop.stopId ||
    manifest.capturedAt !== claimed.at(-1)?.event.occurredAt ||
    manifest.materializedAt !== options.claim.claimedAt ||
    manifest.captureAdapterVersion !== (options.adapterVersion ?? 'capture-v1') ||
    manifest.formatVersion !== 1 ||
    manifest.eventRange.first !== claimed[0]?.event.sequence ||
    manifest.eventRange.last !== options.claim.throughSequence ||
    eventEnvelopes.length !== options.claim.eventKeys.length ||
    manifest.repositoryObservationId !== identity.observationId ||
    manifest.branch !== observation.git.branch ||
    canonicalJson(manifest.codeManifest ?? null) !==
      canonicalJson(observation.codeManifest ?? null) ||
    canonicalJson(manifest.stagedPatch ?? null) !==
      canonicalJson(observation.stagedPatch ?? null) ||
    canonicalJson(manifest.unstagedPatch ?? null) !==
      canonicalJson(observation.unstagedPatch ?? null) ||
    observation.observationId !== manifest.repositoryObservationId ||
    observation.repositoryId !== options.store.manifest.repositoryId
  ) {
    throw new Error('Interrupted materialization graph does not match its durable claim')
  }
  for (let index = 0; index < eventEnvelopes.length; index += 1) {
    const envelope = eventEnvelopes[index]!
    const durable = claimed[index]
    const expectedRaw: ObjectRef | undefined =
      durable === undefined
        ? undefined
        : {
            algorithm: 'sha256',
            sha256: durable.event.rawSha256,
            bytes: durable.event.byteLength,
            mediaType: 'application/json',
            role: 'provider-hook',
          }
    const expectedEnvelope =
      durable === undefined
        ? undefined
        : {
            sequence: durable.event.sequence,
            observedAt: durable.event.occurredAt,
            raw: expectedRaw!,
          }
    if (durable === undefined || canonicalJson(envelope) !== canonicalJson(expectedEnvelope!)) {
      throw new Error('Interrupted Turn event inventory does not match its durable claim')
    }
    await options.store.getObject(envelope.raw)
  }
  const transcriptObjectBytes: Uint8Array[] = []
  for (let index = 0; index < transcriptEnvelopes.length; index += 1) {
    const envelope = transcriptEnvelopes[index]!
    const expectedEnvelope = {
      sequence: index,
      observedAt: options.claim.claimedAt,
      raw: envelope.raw,
    }
    if (
      canonicalJson(envelope) !== canonicalJson(expectedEnvelope) ||
      envelope.raw.algorithm !== 'sha256' ||
      envelope.raw.mediaType !== 'application/x-ndjson' ||
      envelope.raw.role !== 'provider-transcript-observation'
    ) {
      throw new Error('Interrupted Turn transcript inventory does not match its durable claim')
    }
    transcriptObjectBytes.push(await options.store.getObject(envelope.raw))
  }
  const observationRefs = [
    observation.codeManifest,
    observation.stagedPatch,
    observation.unstagedPatch,
  ].filter((reference): reference is ObjectRef => reference !== undefined)
  const patchRefs = [observation.stagedPatch, observation.unstagedPatch].filter(
    (reference): reference is ObjectRef => reference !== undefined,
  )
  const codeObjects: ObjectRef[] = []
  if (observation.codeManifest !== undefined) {
    if (observation.worktreeFingerprint !== observation.codeManifest.sha256) {
      throw new Error('Repository observation fingerprint does not match its code manifest')
    }
    const codeManifest = await loadCodeManifestObject(
      observation.codeManifest,
      async reference => await options.store.getObject(reference),
    )
    for (const entry of codeManifest.entries) {
      if ('object' in entry) codeObjects.push(entry.object)
    }
  }
  for (const reference of [...patchRefs, ...codeObjects]) {
    await options.store.getObject(reference)
  }
  const rawObjects = eventEnvelopes.map(envelope => envelope.raw)
  const transcriptObjects = transcriptEnvelopes.map(envelope => envelope.raw)
  const expectedInventory = uniqueRefs([
    ...rawObjects,
    ...transcriptObjects,
    ...observationRefs,
    ...codeObjects,
  ])
  if (
    canonicalJson(manifest.rawObjects) !== canonicalJson(rawObjects) ||
    canonicalJson(manifest.transcriptObservations) !== canonicalJson(transcriptObjects) ||
    canonicalJson(manifest.inventory) !== canonicalJson(expectedInventory)
  ) {
    throw new Error('Interrupted Turn dependency inventory does not match its durable graph')
  }
  const expectedLimitations = await materializationLimitations(
    options,
    claimed,
    observation,
    transcriptObjectBytes,
  )
  if (canonicalJson(manifest.limitations) !== canonicalJson(expectedLimitations)) {
    throw new Error('Interrupted Turn limitations do not match its durable evidence')
  }
  return { bytes, manifest }
}

export async function materializeStop(
  options: MaterializeStopOptions,
): Promise<MaterializeStopResult> {
  const identity = materializationIdentity(options.claim)
  const claimed = await options.journal.readClaimEvents(options.claim)
  const triggerPath = makeOwnedPath('review-triggers', [`${identity.triggerId}.json`])
  const turnPath = makeOwnedPath('sessions', [
    options.claim.stop.provider,
    identity.sessionKey,
    'turns',
    identity.turnId,
    'manifest.json',
  ])
  const existingTrigger = await options.store.tryReadImmutable(triggerPath)
  if (existingTrigger !== undefined) {
    const trigger = JSON.parse(decoder.decode(existingTrigger)) as ReviewTrigger
    const verified = await verifyMaterializedTurnGraph(options, claimed, identity, turnPath)
    const expectedTrigger: ReviewTrigger = {
      schemaVersion: 1,
      triggerId: identity.triggerId,
      sessionKey: identity.sessionKey,
      turnId: identity.turnId,
      repositoryObservationId: identity.observationId,
      evidenceWatermark: options.claim.throughSequence,
      provider: options.claim.stop.provider,
      createdAt: options.claim.claimedAt,
      materialization: verified.manifest.limitations.length === 0 ? 'complete' : 'partial',
      limitations: verified.manifest.limitations,
    }
    if (canonicalJson(trigger) !== canonicalJson(expectedTrigger)) {
      throw new Error('Existing materialization trigger does not match its durable claim')
    }
    const turn = { path: turnPath, sha256: sha256(verified.bytes) }
    await options.journal.complete(options.claim, {
      ...turn,
      repositoryRoot: options.store.repositoryRoot,
      repositoryId: options.store.manifest.repositoryId,
    })
    return { status: 'materialized', turn }
  }
  if (await hasFactoryConflict(options.repositoryRoot)) {
    return {
      status: 'deferred',
      reason: 'factory-conflict',
      detail: '.factory has unresolved Git conflicts',
    }
  }
  const existingTurn = await options.store.tryReadImmutable(turnPath)
  if (existingTurn !== undefined) {
    const verified = await verifyMaterializedTurnGraph(options, claimed, identity, turnPath)
    const turnManifest = verified.manifest
    const trigger: ReviewTrigger = {
      schemaVersion: 1,
      triggerId: identity.triggerId,
      sessionKey: identity.sessionKey,
      turnId: identity.turnId,
      repositoryObservationId: turnManifest.repositoryObservationId,
      evidenceWatermark: options.claim.throughSequence,
      provider: options.claim.stop.provider,
      createdAt: options.claim.claimedAt,
      materialization: turnManifest.limitations.length === 0 ? 'complete' : 'partial',
      limitations: turnManifest.limitations,
    }
    await options.store.publishImmutableGroup(
      [{ path: triggerPath, bytes: encoder.encode(canonicalJson(trigger)) }],
      triggerPath,
    )
    const turn = { path: turnPath, sha256: sha256(verified.bytes) }
    await options.journal.complete(options.claim, {
      ...turn,
      repositoryRoot: options.store.repositoryRoot,
      repositoryId: options.store.manifest.repositoryId,
    })
    return { status: 'materialized', turn }
  }
  const events: StopMaterializationEvent[] = []
  for (const item of claimed) {
    const raw = await options.store.putObject(
      (async function* () {
        yield item.raw
      })(),
      { mediaType: 'application/json', role: 'provider-hook' },
    )
    events.push({ event: item.event, raw })
  }
  const observationPath = makeOwnedPath('repository-observations', [
    `${identity.observationId}.json`,
  ])
  const existingObservation = await options.store.tryReadImmutable(observationPath)
  let observation: RepositoryObservation
  const codeObjects: ObjectRef[] = []
  if (existingObservation !== undefined) {
    observation = JSON.parse(decoder.decode(existingObservation)) as RepositoryObservation
  } else {
    const observer = new GitObserver(
      options.repositoryRoot,
      {
        put: async (bytes, metadata) =>
          await options.store.putObject(
            (async function* () {
              yield bytes
            })(),
            metadata,
          ),
        get: async reference => await options.store.getObject(reference),
      },
      {
        repositoryId: options.store.manifest.repositoryId,
        observationId: identity.observationId,
        now: () => new Date(options.claim.claimedAt),
      },
    )
    const observed = await observer.observe()
    if (observed.kind === 'unavailable') {
      return { status: 'deferred', reason: 'repository-mismatch', detail: observed.reason.detail }
    }
    observation = observed.kind === 'raced' ? observed.partial : observed.observation
  }
  if (observation.codeManifest !== undefined) {
    if (observation.worktreeFingerprint !== observation.codeManifest.sha256) {
      throw new Error('Repository observation fingerprint does not match its code manifest')
    }
    const manifest = await loadCodeManifestObject(
      observation.codeManifest,
      async reference => await options.store.getObject(reference),
    )
    for (const entry of manifest.entries) {
      if ('object' in entry) codeObjects.push(entry.object)
    }
  }
  const stopRaw = claimed.at(-1)?.raw
  const transcript: TranscriptObservation[] = []
  const transcriptPath = makeOwnedPath('sessions', [
    options.claim.stop.provider,
    identity.sessionKey,
    'turns',
    identity.turnId,
    'transcript.jsonl',
  ])
  const existingTranscript = await options.store.tryReadImmutable(transcriptPath)
  if (existingTranscript !== undefined) {
    for (const line of decoder.decode(existingTranscript).trimEnd().split('\n').filter(Boolean)) {
      const envelope = JSON.parse(line) as EvidenceEnvelope
      transcript.push({ observedAt: envelope.observedAt, raw: envelope.raw })
    }
  } else if (stopRaw !== undefined) {
    try {
      const value = JSON.parse(decoder.decode(stopRaw)) as Record<string, unknown>
      if (typeof value.transcript_path === 'string') {
        const result = await safeTranscript(value.transcript_path, options.providerHome)
        if (result.bytes !== undefined) {
          const raw = await options.store.putObject(
            (async function* () {
              yield result.bytes!
            })(),
            { mediaType: 'application/x-ndjson', role: 'provider-transcript-observation' },
          )
          transcript.push({ observedAt: options.claim.claimedAt, raw })
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error
    }
  }
  const transcriptBytes = await Promise.all(
    transcript.map(async item => await options.store.getObject(item.raw)),
  )
  const limitations = await materializationLimitations(
    options,
    claimed,
    observation,
    transcriptBytes,
  )
  const plan = planTurn({
    repositoryId: options.store.manifest.repositoryId,
    claim: options.claim,
    events,
    observation,
    transcript,
    materializedAt: options.claim.claimedAt,
    adapterVersion: options.adapterVersion ?? 'capture-v1',
    sessionFirstObservedAt: options.sessionFirstObservedAt,
    limitations: limitations.slice(observation.limitations.length),
    codeObjects,
  })
  if ('reason' in plan) return { status: 'deferred', reason: plan.reason, detail: plan.detail }
  const turn = await executeTurn(plan, options.store)
  await options.journal.complete(options.claim, {
    ...turn,
    repositoryRoot: options.store.repositoryRoot,
    repositoryId: options.store.manifest.repositoryId,
  })
  return { status: 'materialized', turn }
}

export function planLifecycleRecord(event: DurableCaptureEvent): {
  path: OwnedPath
  bytes: Uint8Array
} {
  if (event.eventKind !== 'session-end')
    throw new TypeError('only SessionEnd is a lifecycle record')
  const sessionKey = `${event.provider}-${sha256(encoder.encode(`${event.sessionId}\0${event.generation}`)).slice(0, 32)}`
  const eventId = deterministicRecordId('event', event.eventKey, event.occurredAt)
  const value: LifecycleRecord = {
    schemaVersion: 1,
    eventId,
    sessionKey,
    providerEvent: 'SessionEnd',
    observedAt: event.occurredAt,
    raw: {
      algorithm: 'sha256',
      sha256: event.rawSha256,
      bytes: event.byteLength,
      mediaType: 'application/json',
      role: 'provider-hook',
    },
  }
  return {
    path: makeOwnedPath('sessions', [event.provider, sessionKey, 'lifecycle', `${eventId}.json`]),
    bytes: encoder.encode(canonicalJson(value)),
  }
}

export async function materializeLifecycle(
  event: DurableCaptureEvent,
  journal: RuntimeJournal,
  store: RepositoryStore,
): Promise<'materialized' | 'waiting-for-turn'> {
  const planned = planLifecycleRecord(event)
  const identityPath = makeOwnedPath(
    'sessions',
    planned.path.split('/').slice(1, 3).concat('identity.json'),
  )
  if ((await store.tryReadImmutable(identityPath)) === undefined) return 'waiting-for-turn'
  const raw = await journal.readRaw(event)
  const reference = await store.putObject(
    (async function* () {
      yield raw
    })(),
    { mediaType: 'application/json', role: 'provider-hook' },
  )
  if (reference.sha256 !== event.rawSha256 || reference.bytes !== event.byteLength) {
    throw new Error('SessionEnd repository object differs from journal bytes')
  }
  const record = await store.createImmutable(planned.path, planned.bytes)
  await journal.completeLifecycle(event, {
    path: record.path,
    sha256: record.sha256,
    repositoryRoot: store.repositoryRoot,
    repositoryId: store.manifest.repositoryId,
  })
  return 'materialized'
}

/** Bind repository completion proof to the exact durable Stop claim. */
export function verifyTurnCompletion(
  claim: MaterializationClaim,
  reference: TurnRef,
  bytes: Uint8Array,
): void {
  const value = JSON.parse(decoder.decode(bytes)) as TurnManifest
  const expectedSession = `${claim.stop.provider}-${sha256(encoder.encode(`${claim.stop.sessionId}\0${claim.stop.generation}`)).slice(0, 32)}`
  if (
    value.sessionKey !== expectedSession ||
    value.nativeStopId !== claim.stop.stopId ||
    value.eventRange.last !== claim.throughSequence ||
    value.rawObjects.length !== claim.eventKeys.length ||
    !reference.path.startsWith(`sessions/${claim.stop.provider}/${expectedSession}/turns/`) ||
    !reference.path.endsWith(`/${value.turnId}/manifest.json`)
  ) {
    throw new Error('repository Turn proof does not match its materialization claim')
  }
}

/** Bind repository completion proof to the exact durable SessionEnd event. */
export function verifyLifecycleCompletion(
  event: DurableCaptureEvent,
  reference: TurnRef,
  bytes: Uint8Array,
): void {
  const value = JSON.parse(decoder.decode(bytes)) as LifecycleRecord
  const expectedSession = `${event.provider}-${sha256(encoder.encode(`${event.sessionId}\0${event.generation}`)).slice(0, 32)}`
  if (
    value.sessionKey !== expectedSession ||
    value.providerEvent !== 'SessionEnd' ||
    value.observedAt !== event.occurredAt ||
    value.raw.sha256 !== event.rawSha256 ||
    value.raw.bytes !== event.byteLength ||
    !reference.path.startsWith(`sessions/${event.provider}/${expectedSession}/lifecycle/`)
  ) {
    throw new Error('repository lifecycle proof does not match its durable event')
  }
}
