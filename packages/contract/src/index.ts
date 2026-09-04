import { randomBytes } from 'node:crypto'

export const FACTORY_FORMAT_VERSION = 1 as const
export const FACTORY_READER_VERSION = '0.1.0' as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** Portable identity shared by clones that retain the same Factory history. */
export type RepositoryId = `repo_${string}`
/** Collision-resistant, sortable identity that is safe as one path segment. */
export type RecordId = `${string}_${string}`
/** Lowercase SHA-256 over exact object bytes. */
export type Sha256 = string

export type ObjectRef = {
  algorithm: 'sha256'
  sha256: Sha256
  bytes: number
  /** Describes interpretation without changing the authority of the raw bytes. */
  mediaType: string
  /** Explains why the containing record needs this object. */
  role: string
}

/** Git paths are bytes; display text is optional and never replaces the encoding. */
export type EncodedGitPath = {
  encoding: 'base64'
  bytes: string
  display?: string
}

export type LimitationCode =
  | 'missing-event-range'
  | 'missing-transcript-range'
  | 'transcript-race'
  | 'repository-race'
  | 'cross-repository-session'
  | 'unavailable-provider-field'
  | 'unavailable-git-state'
  | 'unavailable-pull-request'
  | 'unverified-object'
  | 'excluded-by-limit'
  | 'corrupt-input'

export type Limitation = {
  code: LimitationCode
  detail: string
  object?: ObjectRef
}

export type RepositoryManifest = {
  schemaVersion: 1
  format: 'factory-repository'
  minimumReaderVersion: string
  repositoryId: RepositoryId
  createdAt: string
}

export type ReviewerSettings = {
  provider: 'codex' | 'claude'
  model?: string
  effort?: string
}

/** Repository policy may defer reviewer resolution until a review is created. */
export type ConfiguredReviewer = 'auto' | (ReviewerSettings & Record<string, JsonValue>)

/** The only mutable public record; unknown keys survive read-modify-write. */
export type RepositoryConfig = Record<string, JsonValue> & {
  canonicalBranch?: string
  reviewer?: ConfiguredReviewer
  automaticReview?: boolean
  decisionConfirmation?: 'required' | 'automatic'
  reviewLimits?: Record<string, JsonValue> & {
    maxBundleBytes?: number
    maxSessions?: number
  }
}

export type SessionIdentity = {
  schemaVersion: 1
  provider: 'codex' | 'claude'
  nativeSessionId: string
  sessionKey: string
  captureGeneration: number
  repositoryId: RepositoryId
  firstObservedAt: string
}

export type LifecycleRecord = {
  schemaVersion: 1
  eventId: RecordId
  sessionKey: string
  providerEvent: string
  observedAt: string
  raw: ObjectRef
}

export type EvidenceEnvelope = {
  sequence: number
  observedAt: string
  raw: ObjectRef
  parsed?: JsonValue
}

export type TurnManifest = {
  schemaVersion: 1
  turnId: RecordId
  sessionKey: string
  nativeStopId: string
  capturedAt: string
  materializedAt: string
  eventRange: { first: number; last: number }
  transcriptObservations: readonly ObjectRef[]
  rawObjects: readonly ObjectRef[]
  repositoryObservationId?: RecordId
  branch?: string
  codeManifest?: ObjectRef
  stagedPatch?: ObjectRef
  unstagedPatch?: ObjectRef
  limitations: readonly Limitation[]
  captureAdapterVersion: string
  formatVersion: 1
  inventory: readonly ObjectRef[]
}

export type RepositoryObservation = {
  schemaVersion: 1
  observationId: RecordId
  repositoryId: RepositoryId
  observedAt: string
  completedAt: string
  git: { head?: string; branch?: string; detached: boolean; index?: string }
  changedPaths: readonly EncodedGitPath[]
  worktreeFingerprint: Sha256
  codeManifest?: ObjectRef
  stagedPatch?: ObjectRef
  unstagedPatch?: ObjectRef
  limitations: readonly Limitation[]
  startState: Sha256
  endState: Sha256
}

/** Exact workspace bytes captured without Git worktree conversion. */
export type CodeManifestEntry =
  | {
      path: EncodedGitPath
      mode: '100644' | '100755'
      kind: 'file' | 'lfs-pointer'
      object: ObjectRef
    }
  | { path: EncodedGitPath; mode: '120000'; kind: 'symlink'; object: ObjectRef }
  | {
      path: EncodedGitPath
      mode: '160000'
      kind: 'gitlink'
      /** Git object identity for a submodule pointer; no checkout is fetched. */
      gitObject: string
    }

/** Reconstructable workspace inventory stored as a content-addressed object. */
export type CodeManifest = {
  schemaVersion: 1
  entries: readonly CodeManifestEntry[]
  limitations: readonly Limitation[]
}

export type PullRequestObservation = {
  schemaVersion: 1
  observationId: RecordId
  provider: 'github'
  repositoryKey: string
  number: number
  state: 'open' | 'closed' | 'merged' | 'unavailable'
  base?: string
  head?: string
  commits: readonly string[]
  observedAt: string
  providerUpdatedAt?: string
  codeManifest?: ObjectRef
  diff?: ObjectRef
  limitations: readonly Limitation[]
}

export type SessionPullRequestAssociation = {
  schemaVersion: 1
  evidenceId: RecordId
  sessionKey: string
  pullRequestObservationId: RecordId
  kind: 'commit' | 'head' | 'code-state-continuity'
  strength: 'verified' | 'strong'
  shas: readonly string[]
  repositoryIdentity: 'same' | 'different' | 'unavailable'
  sourceObservationIds: readonly RecordId[]
  invalidates?: RecordId
  observedAt: string
}

export type ReviewTrigger = {
  schemaVersion: 1
  triggerId: RecordId
  sessionKey: string
  turnId: RecordId
  repositoryObservationId?: RecordId
  evidenceWatermark: number
  provider: 'codex' | 'claude'
  createdAt: string
  materialization: 'complete' | 'partial'
  limitations: readonly Limitation[]
}

export type ReviewManifest = {
  schemaVersion: 1
  reviewId: RecordId
  subject:
    | { kind: 'workspace'; repositoryObservationId: RecordId }
    | {
        kind: 'pull-request'
        provider: 'github'
        repositoryKey: string
        number: number
        observationId: RecordId
      }
  head?: string
  codeManifest?: ObjectRef
  patches: readonly ObjectRef[]
  sessionWatermarks: Readonly<Record<string, number>>
  triggerIds: readonly RecordId[]
  priorLedger?: ObjectRef
  limitations: readonly Limitation[]
  reviewer: ReviewerSettings
  analyzerVersion: string
  promptVersion: string
  policyVersion: string
  formatVersion: 1
  bundleSha256: Sha256
  containerImageDigest: string
  providerCliVersion: string
  hostPlatform: string
  startedAt: string
  completedAt: string
  disposition: 'complete' | 'partial' | 'failed'
  failureReason?: string
}

export type ReviewLedger = {
  schemaVersion: 1
  reviewId: RecordId
  entries: readonly {
    entryId: RecordId
    kind: 'decision' | 'finding' | 'summary'
    summary: string
    evidence: readonly { object: ObjectRef; locator?: string }[]
  }[]
}

export type CoverageAction = {
  schemaVersion: 1
  actionId: RecordId
  reviewId: RecordId
  acceptedLimitations: readonly LimitationCode[]
  settledWatermarks: Readonly<Record<string, number>>
  createdAt: string
}

export type DecisionObservation = {
  schemaVersion: 1
  observationId: RecordId
  reviewId: RecordId
  reviewEntryId: RecordId
  subject: JsonValue
  summary: string
  canonicalBranch: boolean
  confidence: 'low' | 'medium' | 'high'
  observedAt: string
}

export type DecisionAction = {
  schemaVersion: 1
  actionId: RecordId
  kind: 'confirm' | 'reject' | 'dispute' | 'resolve' | 'supersede'
  observationIds: readonly RecordId[]
  actor: { kind: 'review'; reviewId: RecordId } | { kind: 'human'; label?: string }
  createdAt: string
  note?: string
}

export const OWNED_AREAS = [
  'manifest',
  'config',
  'sessions',
  'repository-observations',
  'pull-requests',
  'review-triggers',
  'reviews',
  'decisions',
  'objects',
] as const

export type OwnedArea = (typeof OWNED_AREAS)[number]
export type OwnedPath = string & { readonly ownedPath: unique symbol }

export class UnsupportedRepositoryVersionError extends Error {
  constructor(readonly minimumReaderVersion: string) {
    super(
      `Factory repository requires reader ${minimumReaderVersion}; installed reader is ${FACTORY_READER_VERSION}`,
    )
    this.name = 'UnsupportedRepositoryVersionError'
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`)
  }
}

function compareVersion(left: string, right: string): number {
  const parse = (value: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new TypeError(`invalid semantic version: ${value}`)
    return value.split('.').map(Number)
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function parseRepositoryManifest(value: unknown): RepositoryManifest {
  assertRecord(value, 'repository manifest')
  if (typeof value.minimumReaderVersion !== 'string') {
    throw new TypeError('repository manifest minimumReaderVersion must be a string')
  }
  if (compareVersion(value.minimumReaderVersion, FACTORY_READER_VERSION) > 0) {
    throw new UnsupportedRepositoryVersionError(value.minimumReaderVersion)
  }
  assertExactKeys(
    value,
    ['schemaVersion', 'format', 'minimumReaderVersion', 'repositoryId', 'createdAt'],
    'repository manifest',
  )
  if (
    value.schemaVersion !== 1 ||
    value.format !== 'factory-repository' ||
    typeof value.repositoryId !== 'string' ||
    !/^repo_[A-Za-z0-9_-]+$/.test(value.repositoryId)
  ) {
    throw new TypeError('invalid Factory repository manifest')
  }
  assertTimestamp(value.createdAt, 'repository manifest createdAt')
  return value as RepositoryManifest
}

export function parseRepositoryConfig(value: unknown): RepositoryConfig {
  assertRecord(value, 'repository config')
  canonicalJson(value)
  if (
    'canonicalBranch' in value &&
    (typeof value.canonicalBranch !== 'string' || value.canonicalBranch.length === 0)
  ) {
    throw new TypeError('canonicalBranch must be a string')
  }
  if ('automaticReview' in value && typeof value.automaticReview !== 'boolean') {
    throw new TypeError('automaticReview must be a boolean')
  }
  if (
    'decisionConfirmation' in value &&
    value.decisionConfirmation !== 'required' &&
    value.decisionConfirmation !== 'automatic'
  ) {
    throw new TypeError('decisionConfirmation is unsupported')
  }
  if ('reviewer' in value) {
    if (value.reviewer !== 'auto') {
      assertRecord(value.reviewer, 'reviewer config')
      if (!('provider' in value.reviewer)) throw new TypeError('reviewer provider is required')
      assertEnum(value.reviewer.provider, ['codex', 'claude'], 'reviewer config.provider')
      if ('model' in value.reviewer) assertString(value.reviewer.model, 'reviewer config.model')
      if ('effort' in value.reviewer) assertString(value.reviewer.effort, 'reviewer config.effort')
    }
  }
  if ('reviewLimits' in value) {
    assertRecord(value.reviewLimits, 'review limits')
    for (const key of ['maxBundleBytes', 'maxSessions']) {
      if (key in value.reviewLimits) {
        const limit = value.reviewLimits[key]
        if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
          throw new TypeError(`review limit ${key} must be a positive integer`)
        }
      }
    }
  }
  return value as RepositoryConfig
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON refuses non-finite numbers')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new TypeError(`canonical JSON refuses ${typeof value}`)
  }
  if (ancestors.has(value)) throw new TypeError('canonical JSON refuses cyclic values')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(entry => canonicalize(entry, ancestors)).join(',')}]`
    }
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(object[key], ancestors)}`)
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

/** Deterministic UTF-8 JSON used by every Factory-authored structured file. */
export function canonicalJson(value: unknown): string {
  return `${canonicalize(value, new Set())}\n`
}

export function makeOwnedPath(area: OwnedArea, segments: readonly string[] = []): OwnedPath {
  if (!(OWNED_AREAS as readonly unknown[]).includes(area)) {
    throw new TypeError(`Factory does not own area: ${String(area)}`)
  }
  const root = area === 'manifest' ? 'manifest.json' : area === 'config' ? 'config.json' : area
  if ((area === 'manifest' || area === 'config') && segments.length !== 0) {
    throw new TypeError(`${area} does not accept child segments`)
  }
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0')
    ) {
      throw new TypeError(`Factory owned paths require a safe path segment: ${segment}`)
    }
  }
  return [root, ...segments].join('/') as OwnedPath
}

export function objectOwnedPath(hash: Sha256): OwnedPath {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new TypeError('object hash must be lowercase SHA-256')
  return makeOwnedPath('objects', ['sha256', hash.slice(0, 2), hash.slice(2)])
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function base32(value: bigint, length: number): string {
  let remaining = value
  let encoded = ''
  for (let index = 0; index < length; index += 1) {
    encoded = `${CROCKFORD[Number(remaining & 31n)]}${encoded}`
    remaining >>= 5n
  }
  return encoded
}

/** Create a time-sortable, collision-resistant Factory record identity. */
export function newRecordId(
  prefix: string,
  now = Date.now(),
  entropy: Uint8Array = randomBytes(10),
): RecordId {
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw new TypeError('record ID prefix is invalid')
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new TypeError('record ID timestamp is outside the 48-bit range')
  }
  if (entropy.byteLength !== 10) throw new TypeError('record ID entropy must contain 80 bits')
  let random = 0n
  for (const byte of entropy) random = (random << 8n) | BigInt(byte)
  return `${prefix}_${base32(BigInt(now), 10)}${base32(random, 16)}`
}

export function encodeGitPath(bytes: Uint8Array, display?: string): EncodedGitPath {
  return {
    encoding: 'base64',
    bytes: Buffer.from(bytes).toString('base64'),
    ...(display === undefined ? {} : { display }),
  }
}

export function decodeGitPath(path: EncodedGitPath): Uint8Array {
  if (
    path.encoding !== 'base64' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(path.bytes)
  ) {
    throw new TypeError('Git path must use canonical base64')
  }
  const decoded = Buffer.from(path.bytes, 'base64')
  if (decoded.toString('base64') !== path.bytes)
    throw new TypeError('Git path base64 is not canonical')
  return decoded
}

export function validateObjectRef(value: ObjectRef): void {
  assertRecord(value, 'object reference')
  assertExactKeys(value, ['algorithm', 'sha256', 'bytes', 'mediaType', 'role'], 'object reference')
  if (value.algorithm !== 'sha256') throw new TypeError('object reference algorithm is unsupported')
  assertSha256(value.sha256, 'object reference sha256')
  assertNonNegativeInteger(value.bytes, 'object reference bytes')
  assertString(value.mediaType, 'object reference mediaType')
  assertString(value.role, 'object reference role')
}

/** Reject fields that would make generated metadata machine-specific. */
export function assertNoMachinePaths(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoMachinePaths(entry, `${path}[${index}]`))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === 'string' &&
      /(hostPath|absolutePath|checkoutPath|homePath)$/i.test(key) &&
      (child.startsWith('/') || /^[A-Za-z]:[\\/]/.test(child))
    ) {
      throw new TypeError(`Factory metadata contains an absolute machine path at ${path}.${key}`)
    }
    assertNoMachinePaths(child, `${path}.${key}`)
  }
}

const RECORD_KEYS = {
  sessionIdentity: [
    'schemaVersion',
    'provider',
    'nativeSessionId',
    'sessionKey',
    'captureGeneration',
    'repositoryId',
    'firstObservedAt',
  ],
  lifecycle: ['schemaVersion', 'eventId', 'sessionKey', 'providerEvent', 'observedAt', 'raw'],
  turn: [
    'schemaVersion',
    'turnId',
    'sessionKey',
    'nativeStopId',
    'capturedAt',
    'materializedAt',
    'eventRange',
    'transcriptObservations',
    'rawObjects',
    'repositoryObservationId',
    'branch',
    'codeManifest',
    'stagedPatch',
    'unstagedPatch',
    'limitations',
    'captureAdapterVersion',
    'formatVersion',
    'inventory',
  ],
  repositoryObservation: [
    'schemaVersion',
    'observationId',
    'repositoryId',
    'observedAt',
    'completedAt',
    'git',
    'changedPaths',
    'worktreeFingerprint',
    'codeManifest',
    'stagedPatch',
    'unstagedPatch',
    'limitations',
    'startState',
    'endState',
  ],
  pullRequestObservation: [
    'schemaVersion',
    'observationId',
    'provider',
    'repositoryKey',
    'number',
    'state',
    'base',
    'head',
    'commits',
    'observedAt',
    'providerUpdatedAt',
    'codeManifest',
    'diff',
    'limitations',
  ],
  association: [
    'schemaVersion',
    'evidenceId',
    'sessionKey',
    'pullRequestObservationId',
    'kind',
    'strength',
    'shas',
    'repositoryIdentity',
    'sourceObservationIds',
    'invalidates',
    'observedAt',
  ],
  trigger: [
    'schemaVersion',
    'triggerId',
    'sessionKey',
    'turnId',
    'repositoryObservationId',
    'evidenceWatermark',
    'provider',
    'createdAt',
    'materialization',
    'limitations',
  ],
  review: [
    'schemaVersion',
    'reviewId',
    'subject',
    'head',
    'codeManifest',
    'patches',
    'sessionWatermarks',
    'triggerIds',
    'priorLedger',
    'limitations',
    'reviewer',
    'analyzerVersion',
    'promptVersion',
    'policyVersion',
    'formatVersion',
    'bundleSha256',
    'containerImageDigest',
    'providerCliVersion',
    'hostPlatform',
    'startedAt',
    'completedAt',
    'disposition',
    'failureReason',
  ],
  ledger: ['schemaVersion', 'reviewId', 'entries'],
  coverage: [
    'schemaVersion',
    'actionId',
    'reviewId',
    'acceptedLimitations',
    'settledWatermarks',
    'createdAt',
  ],
  decisionObservation: [
    'schemaVersion',
    'observationId',
    'reviewId',
    'reviewEntryId',
    'subject',
    'summary',
    'canonicalBranch',
    'confidence',
    'observedAt',
  ],
  decisionAction: [
    'schemaVersion',
    'actionId',
    'kind',
    'observationIds',
    'actor',
    'createdAt',
    'note',
  ],
} as const

type RecordKind = keyof typeof RECORD_KEYS
type RecordPath =
  | { kind: 'sessionIdentity'; provider: string; sessionKey: string }
  | { kind: 'lifecycle'; provider: string; sessionKey: string; eventId: string }
  | { kind: 'turn'; provider: string; sessionKey: string; turnId: string }
  | { kind: 'envelope'; provider: string; sessionKey: string; turnId: string }
  | { kind: 'repositoryObservation'; observationId: string }
  | { kind: 'pullRequestObservation'; repositoryKey: string; number: number; observationId: string }
  | {
      kind: 'association'
      repositoryKey: string
      number: number
      observationId: string
      evidenceId: string
    }
  | { kind: 'trigger'; triggerId: string }
  | {
      kind: 'review' | 'ledger'
      reviewId: string
      subject:
        | { kind: 'workspace' }
        | { kind: 'pull-request'; repositoryKey: string; number: number }
    }
  | {
      kind: 'response'
      reviewId: string
      subject:
        | { kind: 'workspace' }
        | { kind: 'pull-request'; repositoryKey: string; number: number }
    }
  | { kind: 'coverage'; actionId: string }
  | { kind: 'decisionObservation'; observationId: string }
  | { kind: 'decisionAction'; actionId: string }

function parseRecordPath(path: OwnedPath): RecordPath {
  let match = /^sessions\/([^/]+)\/([^/]+)\/identity\.json$/.exec(path)
  if (match) return { kind: 'sessionIdentity', provider: match[1]!, sessionKey: match[2]! }
  match = /^sessions\/([^/]+)\/([^/]+)\/lifecycle\/([^/]+)\.json$/.exec(path)
  if (match)
    return { kind: 'lifecycle', provider: match[1]!, sessionKey: match[2]!, eventId: match[3]! }
  match = /^sessions\/([^/]+)\/([^/]+)\/turns\/([^/]+)\/manifest\.json$/.exec(path)
  if (match) return { kind: 'turn', provider: match[1]!, sessionKey: match[2]!, turnId: match[3]! }
  match = /^sessions\/([^/]+)\/([^/]+)\/turns\/([^/]+)\/(?:events|transcript)\.jsonl$/.exec(path)
  if (match)
    return { kind: 'envelope', provider: match[1]!, sessionKey: match[2]!, turnId: match[3]! }
  match = /^repository-observations\/([^/]+)\.json$/.exec(path)
  if (match) return { kind: 'repositoryObservation', observationId: match[1]! }
  match = /^pull-requests\/github\/([^/]+)\/([1-9]\d*)\/observations\/([^/]+)\.json$/.exec(path)
  if (match)
    return {
      kind: 'pullRequestObservation',
      repositoryKey: match[1]!,
      number: Number(match[2]),
      observationId: match[3]!,
    }
  match = /^pull-requests\/github\/([^/]+)\/([1-9]\d*)\/associations\/([^/]+)\/([^/]+)\.json$/.exec(
    path,
  )
  if (match)
    return {
      kind: 'association',
      repositoryKey: match[1]!,
      number: Number(match[2]),
      observationId: match[3]!,
      evidenceId: match[4]!,
    }
  match = /^review-triggers\/([^/]+)\.json$/.exec(path)
  if (match) return { kind: 'trigger', triggerId: match[1]! }
  match = /^reviews\/workspace\/([^/]+)\/(manifest\.json|ledger\.json|response\.txt)$/.exec(path)
  if (match)
    return {
      kind:
        match[2] === 'manifest.json'
          ? 'review'
          : match[2] === 'ledger.json'
            ? 'ledger'
            : 'response',
      reviewId: match[1]!,
      subject: { kind: 'workspace' },
    }
  match =
    /^reviews\/pull-requests\/github\/([^/]+)\/([1-9]\d*)\/([^/]+)\/(manifest\.json|ledger\.json|response\.txt)$/.exec(
      path,
    )
  if (match)
    return {
      kind:
        match[4] === 'manifest.json'
          ? 'review'
          : match[4] === 'ledger.json'
            ? 'ledger'
            : 'response',
      reviewId: match[3]!,
      subject: { kind: 'pull-request', repositoryKey: match[1]!, number: Number(match[2]) },
    }
  match = /^reviews\/coverage-actions\/([^/]+)\.json$/.exec(path)
  if (match) return { kind: 'coverage', actionId: match[1]! }
  match = /^decisions\/observations\/([^/]+)\.json$/.exec(path)
  if (match) return { kind: 'decisionObservation', observationId: match[1]! }
  match = /^decisions\/actions\/([^/]+)\.json$/.exec(path)
  if (match) return { kind: 'decisionAction', actionId: match[1]! }
  throw new TypeError(`path is not a declared Factory v1 record: ${path}`)
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const extras = Object.keys(value).filter(key => !allowed.includes(key))
  if (extras.length > 0)
    throw new TypeError(`${label} contains unknown fields: ${extras.join(', ')}`)
}

function assertBaseRecord(
  value: unknown,
  kind: RecordKind,
): asserts value is Record<string, unknown> {
  assertRecord(value, kind)
  assertExactKeys(value, RECORD_KEYS[kind], kind)
  if (value.schemaVersion !== 1) throw new TypeError(`${kind} schemaVersion must be 1`)
}

function requireFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  kind: string,
): void {
  for (const field of fields) {
    if (!(field in value)) throw new TypeError(`${kind} requires ${field}`)
  }
}

const LIMITATION_CODES = new Set<LimitationCode>([
  'missing-event-range',
  'missing-transcript-range',
  'transcript-race',
  'repository-race',
  'cross-repository-session',
  'unavailable-provider-field',
  'unavailable-git-state',
  'unavailable-pull-request',
  'unverified-object',
  'excluded-by-limit',
  'corrupt-input',
])

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
}

function assertEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`${label} is unsupported`)
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`)
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive integer`)
  }
}

function assertSha256(value: unknown, label: string): asserts value is Sha256 {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256`)
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertString(value, label)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value)
  const parsed = new Date(value)
  if (
    !match ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() + 1 !== Number(match[2]) ||
    parsed.getUTCDate() !== Number(match[3]) ||
    parsed.getUTCHours() !== Number(match[4]) ||
    parsed.getUTCMinutes() !== Number(match[5]) ||
    parsed.getUTCSeconds() !== Number(match[6])
  ) {
    throw new TypeError(`${label} must be a UTC RFC 3339 timestamp`)
  }
}

function assertRecordId(value: unknown, label: string): asserts value is RecordId {
  assertString(value, label)
  if (!/^[a-z][a-z0-9-]*_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)) {
    throw new TypeError(`${label} must be a sortable Factory record ID`)
  }
}

function assertRecordIdArray(value: unknown, label: string): asserts value is RecordId[] {
  assertArray(value, label)
  value.forEach((entry, index) => assertRecordId(entry, `${label}[${index}]`))
}

function assertGitObjectIds(value: unknown, label: string): asserts value is string[] {
  assertArray(value, label)
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry)) {
      throw new TypeError(`${label}[${index}] must be a lowercase Git object ID`)
    }
  })
}

function assertObjectRef(value: unknown, label: string): asserts value is ObjectRef {
  try {
    validateObjectRef(value as ObjectRef)
  } catch (error) {
    throw new TypeError(`${label}: ${(error as Error).message}`)
  }
}

function assertObjectRefs(value: unknown, label: string): asserts value is ObjectRef[] {
  assertArray(value, label)
  value.forEach((entry, index) => assertObjectRef(entry, `${label}[${index}]`))
}

function assertLimitations(value: unknown, label: string): asserts value is Limitation[] {
  assertArray(value, label)
  value.forEach((entry, index) => {
    const itemLabel = `${label}[${index}]`
    assertRecord(entry, itemLabel)
    assertExactKeys(entry, ['code', 'detail', 'object'], itemLabel)
    requireFields(entry, ['code', 'detail'], itemLabel)
    assertEnum(entry.code, [...LIMITATION_CODES], `${itemLabel}.code`)
    assertString(entry.detail, `${itemLabel}.detail`)
    if ('object' in entry) assertObjectRef(entry.object, `${itemLabel}.object`)
  })
}

/** Validate the canonical object payload used to reconstruct a workspace. */
export function parseCodeManifest(value: unknown): CodeManifest {
  assertRecord(value, 'code manifest')
  assertExactKeys(value, ['schemaVersion', 'entries', 'limitations'], 'code manifest')
  requireFields(value, ['schemaVersion', 'entries', 'limitations'], 'code manifest')
  if (value.schemaVersion !== 1) throw new TypeError('code manifest schemaVersion must be 1')
  assertArray(value.entries, 'code manifest entries')
  let previous: Buffer | undefined
  const seen = new Set<string>()
  value.entries.forEach((entry, index) => {
    const label = `code manifest entries[${index}]`
    assertRecord(entry, label)
    assertExactKeys(entry, ['path', 'mode', 'kind', 'object', 'gitObject'], label)
    requireFields(entry, ['path', 'mode', 'kind'], label)
    assertRecord(entry.path, `${label}.path`)
    assertExactKeys(entry.path, ['encoding', 'bytes', 'display'], `${label}.path`)
    requireFields(entry.path, ['encoding', 'bytes'], `${label}.path`)
    if ('display' in entry.path) assertString(entry.path.display, `${label}.path.display`)
    const path = decodeGitPath(entry.path as EncodedGitPath)
    if (path.byteLength === 0 || path[0] === 47 || path.includes(0)) {
      throw new TypeError(`${label}.path is unsafe`)
    }
    const segments = Buffer.from(path).toString('binary').split('/')
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new TypeError(`${label}.path contains traversal`)
    }
    if (segments.includes('.git') || segments[0] === '.factory') {
      throw new TypeError(`${label}.path enters a reserved repository namespace`)
    }
    if (previous !== undefined && Buffer.compare(previous, Buffer.from(path)) >= 0) {
      throw new TypeError('code manifest entries must be uniquely byte-sorted')
    }
    previous = Buffer.from(path)
    const key = Buffer.from(path).toString('base64')
    if (seen.has(key)) throw new TypeError('code manifest contains duplicate paths')
    const pathBytes = Buffer.from(path)
    for (let index = 0; index < pathBytes.byteLength; index += 1) {
      if (pathBytes[index] === 47 && seen.has(pathBytes.subarray(0, index).toString('base64'))) {
        throw new TypeError('code manifest contains a file/ancestor path collision')
      }
    }
    seen.add(key)
    assertEnum(entry.mode, ['100644', '100755', '120000', '160000'], `${label}.mode`)
    assertEnum(entry.kind, ['file', 'symlink', 'gitlink', 'lfs-pointer'], `${label}.kind`)
    if (entry.kind === 'gitlink') {
      if (entry.mode !== '160000' || 'object' in entry || !('gitObject' in entry)) {
        throw new TypeError(`${label} gitlink shape is invalid`)
      }
      if (
        typeof entry.gitObject !== 'string' ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.gitObject)
      ) {
        throw new TypeError(`${label}.gitObject is invalid`)
      }
    } else {
      if (!('object' in entry) || 'gitObject' in entry)
        throw new TypeError(`${label} object shape is invalid`)
      assertObjectRef(entry.object, `${label}.object`)
      const object = entry.object as ObjectRef
      if (entry.kind === 'symlink') {
        if (entry.mode !== '120000') throw new TypeError(`${label} symlink mode is invalid`)
        if (
          object.mediaType !== 'application/vnd.factory.symlink-target' ||
          object.role !== 'workspace-file'
        ) {
          throw new TypeError(`${label} symlink object semantics are invalid`)
        }
      }
      if (
        entry.kind === 'lfs-pointer' &&
        (object.mediaType !== 'application/octet-stream' || object.role !== 'git-lfs-pointer')
      ) {
        throw new TypeError(`${label} LFS object semantics are invalid`)
      }
      if (
        entry.kind === 'file' &&
        (object.mediaType !== 'application/octet-stream' || object.role !== 'workspace-file')
      ) {
        throw new TypeError(`${label} file object semantics are invalid`)
      }
      if (entry.kind !== 'symlink' && !['100644', '100755'].includes(entry.mode as string)) {
        throw new TypeError(`${label} file mode is invalid`)
      }
    }
  })
  assertLimitations(value.limitations, 'code manifest limitations')
  return value as CodeManifest
}

function assertReviewer(value: unknown, label: string): asserts value is ReviewerSettings {
  assertRecord(value, label)
  assertExactKeys(value, ['provider', 'model', 'effort'], label)
  requireFields(value, ['provider'], label)
  assertEnum(value.provider, ['codex', 'claude'], `${label}.provider`)
  if ('model' in value) assertString(value.model, `${label}.model`)
  if ('effort' in value) assertString(value.effort, `${label}.effort`)
}

function assertOptionalString(value: Record<string, unknown>, key: string, label: string): void {
  if (key in value) assertString(value[key], `${label}.${key}`)
}

function assertOptionalObjectRef(value: Record<string, unknown>, key: string, label: string): void {
  if (key in value) assertObjectRef(value[key], `${label}.${key}`)
}

function assertIdentity(actual: unknown, expected: string | number, label: string): void {
  if (actual !== expected) throw new TypeError(`${label} must match its owned path`)
}

function assertWatermarks(value: unknown, label: string): void {
  assertRecord(value, label)
  for (const [sessionKey, watermark] of Object.entries(value)) {
    assertString(sessionKey, `${label} session key`)
    assertNonNegativeInteger(watermark, `${label}.${sessionKey}`)
  }
}

function validateRecordShape(
  path: Exclude<RecordPath, { kind: 'envelope' | 'response' }>,
  value: unknown,
): void {
  const kind = path.kind
  assertBaseRecord(value, kind)
  const required: Record<RecordKind, readonly string[]> = {
    sessionIdentity: RECORD_KEYS.sessionIdentity,
    lifecycle: RECORD_KEYS.lifecycle,
    turn: RECORD_KEYS.turn.filter(
      key =>
        ![
          'repositoryObservationId',
          'branch',
          'codeManifest',
          'stagedPatch',
          'unstagedPatch',
        ].includes(key),
    ),
    repositoryObservation: RECORD_KEYS.repositoryObservation.filter(
      key => !['codeManifest', 'stagedPatch', 'unstagedPatch'].includes(key),
    ),
    pullRequestObservation: RECORD_KEYS.pullRequestObservation.filter(
      key => !['base', 'head', 'providerUpdatedAt', 'codeManifest', 'diff'].includes(key),
    ),
    association: RECORD_KEYS.association.filter(key => key !== 'invalidates'),
    trigger: RECORD_KEYS.trigger.filter(key => key !== 'repositoryObservationId'),
    review: RECORD_KEYS.review.filter(
      key => !['head', 'codeManifest', 'priorLedger', 'failureReason'].includes(key),
    ),
    ledger: RECORD_KEYS.ledger,
    coverage: RECORD_KEYS.coverage,
    decisionObservation: RECORD_KEYS.decisionObservation,
    decisionAction: RECORD_KEYS.decisionAction.filter(key => key !== 'note'),
  }
  requireFields(value, required[kind], kind)

  switch (kind) {
    case 'sessionIdentity':
      assertEnum(value.provider, ['codex', 'claude'], 'sessionIdentity.provider')
      assertString(value.nativeSessionId, 'sessionIdentity.nativeSessionId')
      assertString(value.sessionKey, 'sessionIdentity.sessionKey')
      assertPositiveInteger(value.captureGeneration, 'sessionIdentity.captureGeneration')
      assertString(value.repositoryId, 'sessionIdentity.repositoryId')
      if (!/^repo_[A-Za-z0-9_-]+$/.test(value.repositoryId))
        throw new TypeError('sessionIdentity.repositoryId is invalid')
      assertTimestamp(value.firstObservedAt, 'sessionIdentity.firstObservedAt')
      assertIdentity(value.provider, path.provider, 'sessionIdentity.provider')
      assertIdentity(value.sessionKey, path.sessionKey, 'sessionIdentity.sessionKey')
      break
    case 'lifecycle':
      assertRecordId(value.eventId, 'lifecycle.eventId')
      assertString(value.sessionKey, 'lifecycle.sessionKey')
      assertString(value.providerEvent, 'lifecycle.providerEvent')
      assertTimestamp(value.observedAt, 'lifecycle.observedAt')
      assertObjectRef(value.raw, 'lifecycle.raw')
      assertIdentity(value.sessionKey, path.sessionKey, 'lifecycle.sessionKey')
      assertIdentity(value.eventId, path.eventId, 'lifecycle.eventId')
      if (!['codex', 'claude'].includes(path.provider))
        throw new TypeError('lifecycle path provider is unsupported')
      break
    case 'turn': {
      assertRecordId(value.turnId, 'turn.turnId')
      assertString(value.sessionKey, 'turn.sessionKey')
      assertString(value.nativeStopId, 'turn.nativeStopId')
      assertTimestamp(value.capturedAt, 'turn.capturedAt')
      assertTimestamp(value.materializedAt, 'turn.materializedAt')
      assertRecord(value.eventRange, 'turn.eventRange')
      assertExactKeys(value.eventRange, ['first', 'last'], 'turn.eventRange')
      requireFields(value.eventRange, ['first', 'last'], 'turn.eventRange')
      assertNonNegativeInteger(value.eventRange.first, 'turn.eventRange.first')
      assertNonNegativeInteger(value.eventRange.last, 'turn.eventRange.last')
      if (value.eventRange.last < value.eventRange.first)
        throw new TypeError('turn.eventRange must be ordered')
      assertObjectRefs(value.transcriptObservations, 'turn.transcriptObservations')
      assertObjectRefs(value.rawObjects, 'turn.rawObjects')
      if ('repositoryObservationId' in value) {
        assertRecordId(value.repositoryObservationId, 'turn.repositoryObservationId')
      }
      assertOptionalString(value, 'branch', 'turn')
      for (const key of ['codeManifest', 'stagedPatch', 'unstagedPatch'])
        assertOptionalObjectRef(value, key, 'turn')
      assertLimitations(value.limitations, 'turn.limitations')
      assertString(value.captureAdapterVersion, 'turn.captureAdapterVersion')
      if (value.formatVersion !== 1) throw new TypeError('turn.formatVersion must be 1')
      assertObjectRefs(value.inventory, 'turn.inventory')
      assertIdentity(value.sessionKey, path.sessionKey, 'turn.sessionKey')
      assertIdentity(value.turnId, path.turnId, 'turn.turnId')
      if (!['codex', 'claude'].includes(path.provider))
        throw new TypeError('turn path provider is unsupported')
      break
    }
    case 'repositoryObservation': {
      assertRecordId(value.observationId, 'repositoryObservation.observationId')
      assertString(value.repositoryId, 'repositoryObservation.repositoryId')
      if (!/^repo_[A-Za-z0-9_-]+$/.test(value.repositoryId))
        throw new TypeError('repositoryObservation.repositoryId is invalid')
      assertTimestamp(value.observedAt, 'repositoryObservation.observedAt')
      assertTimestamp(value.completedAt, 'repositoryObservation.completedAt')
      assertRecord(value.git, 'repositoryObservation.git')
      assertExactKeys(
        value.git,
        ['head', 'branch', 'detached', 'index'],
        'repositoryObservation.git',
      )
      requireFields(value.git, ['detached'], 'repositoryObservation.git')
      assertBoolean(value.git.detached, 'repositoryObservation.git.detached')
      for (const key of ['head', 'branch', 'index'])
        assertOptionalString(value.git, key, 'repositoryObservation.git')
      assertArray(value.changedPaths, 'repositoryObservation.changedPaths')
      value.changedPaths.forEach((entry, index) => {
        const label = `repositoryObservation.changedPaths[${index}]`
        assertRecord(entry, label)
        assertExactKeys(entry, ['encoding', 'bytes', 'display'], label)
        requireFields(entry, ['encoding', 'bytes'], label)
        if (entry.encoding !== 'base64') throw new TypeError(`${label}.encoding is unsupported`)
        assertString(entry.bytes, `${label}.bytes`)
        if ('display' in entry) assertString(entry.display, `${label}.display`)
        decodeGitPath(entry as EncodedGitPath)
      })
      for (const key of ['worktreeFingerprint', 'startState', 'endState'])
        assertSha256(value[key], `repositoryObservation.${key}`)
      for (const key of ['codeManifest', 'stagedPatch', 'unstagedPatch'])
        assertOptionalObjectRef(value, key, 'repositoryObservation')
      assertLimitations(value.limitations, 'repositoryObservation.limitations')
      assertIdentity(value.observationId, path.observationId, 'repositoryObservation.observationId')
      break
    }
    case 'pullRequestObservation':
      assertRecordId(value.observationId, 'pullRequestObservation.observationId')
      assertIdentity(value.provider, 'github', 'pullRequestObservation.provider')
      assertString(value.repositoryKey, 'pullRequestObservation.repositoryKey')
      assertPositiveInteger(value.number, 'pullRequestObservation.number')
      assertEnum(
        value.state,
        ['open', 'closed', 'merged', 'unavailable'],
        'pullRequestObservation.state',
      )
      for (const key of ['base', 'head']) assertOptionalString(value, key, 'pullRequestObservation')
      assertGitObjectIds(value.commits, 'pullRequestObservation.commits')
      assertTimestamp(value.observedAt, 'pullRequestObservation.observedAt')
      if ('providerUpdatedAt' in value)
        assertTimestamp(value.providerUpdatedAt, 'pullRequestObservation.providerUpdatedAt')
      for (const key of ['codeManifest', 'diff'])
        assertOptionalObjectRef(value, key, 'pullRequestObservation')
      assertLimitations(value.limitations, 'pullRequestObservation.limitations')
      assertIdentity(
        value.repositoryKey,
        path.repositoryKey,
        'pullRequestObservation.repositoryKey',
      )
      assertIdentity(value.number, path.number, 'pullRequestObservation.number')
      assertIdentity(
        value.observationId,
        path.observationId,
        'pullRequestObservation.observationId',
      )
      break
    case 'association':
      assertRecordId(value.evidenceId, 'association.evidenceId')
      assertString(value.sessionKey, 'association.sessionKey')
      assertRecordId(value.pullRequestObservationId, 'association.pullRequestObservationId')
      assertEnum(value.kind, ['commit', 'head', 'code-state-continuity'], 'association.kind')
      assertEnum(value.strength, ['verified', 'strong'], 'association.strength')
      assertGitObjectIds(value.shas, 'association.shas')
      assertEnum(
        value.repositoryIdentity,
        ['same', 'different', 'unavailable'],
        'association.repositoryIdentity',
      )
      assertRecordIdArray(value.sourceObservationIds, 'association.sourceObservationIds')
      if ('invalidates' in value) assertRecordId(value.invalidates, 'association.invalidates')
      assertTimestamp(value.observedAt, 'association.observedAt')
      assertIdentity(
        value.pullRequestObservationId,
        path.observationId,
        'association.pullRequestObservationId',
      )
      assertIdentity(value.evidenceId, path.evidenceId, 'association.evidenceId')
      break
    case 'trigger':
      assertRecordId(value.triggerId, 'trigger.triggerId')
      assertString(value.sessionKey, 'trigger.sessionKey')
      assertRecordId(value.turnId, 'trigger.turnId')
      if ('repositoryObservationId' in value) {
        assertRecordId(value.repositoryObservationId, 'trigger.repositoryObservationId')
      }
      assertNonNegativeInteger(value.evidenceWatermark, 'trigger.evidenceWatermark')
      assertEnum(value.provider, ['codex', 'claude'], 'trigger.provider')
      assertTimestamp(value.createdAt, 'trigger.createdAt')
      assertEnum(value.materialization, ['complete', 'partial'], 'trigger.materialization')
      assertLimitations(value.limitations, 'trigger.limitations')
      assertIdentity(value.triggerId, path.triggerId, 'trigger.triggerId')
      break
    case 'review': {
      assertRecordId(value.reviewId, 'review.reviewId')
      assertRecord(value.subject, 'review.subject')
      if (path.subject.kind === 'workspace') {
        assertExactKeys(value.subject, ['kind', 'repositoryObservationId'], 'review.subject')
        requireFields(value.subject, ['kind', 'repositoryObservationId'], 'review.subject')
        assertIdentity(value.subject.kind, 'workspace', 'review.subject.kind')
        assertRecordId(
          value.subject.repositoryObservationId,
          'review.subject.repositoryObservationId',
        )
      } else {
        assertExactKeys(
          value.subject,
          ['kind', 'provider', 'repositoryKey', 'number', 'observationId'],
          'review.subject',
        )
        requireFields(
          value.subject,
          ['kind', 'provider', 'repositoryKey', 'number', 'observationId'],
          'review.subject',
        )
        assertIdentity(value.subject.kind, 'pull-request', 'review.subject.kind')
        assertIdentity(value.subject.provider, 'github', 'review.subject.provider')
        assertString(value.subject.repositoryKey, 'review.subject.repositoryKey')
        assertPositiveInteger(value.subject.number, 'review.subject.number')
        assertRecordId(value.subject.observationId, 'review.subject.observationId')
        assertIdentity(
          value.subject.repositoryKey,
          path.subject.repositoryKey,
          'review.subject.repositoryKey',
        )
        assertIdentity(value.subject.number, path.subject.number, 'review.subject.number')
      }
      assertOptionalString(value, 'head', 'review')
      assertOptionalObjectRef(value, 'codeManifest', 'review')
      assertObjectRefs(value.patches, 'review.patches')
      assertWatermarks(value.sessionWatermarks, 'review.sessionWatermarks')
      assertRecordIdArray(value.triggerIds, 'review.triggerIds')
      assertOptionalObjectRef(value, 'priorLedger', 'review')
      assertLimitations(value.limitations, 'review.limitations')
      assertReviewer(value.reviewer, 'review.reviewer')
      for (const key of [
        'analyzerVersion',
        'promptVersion',
        'policyVersion',
        'containerImageDigest',
        'providerCliVersion',
        'hostPlatform',
      ])
        assertString(value[key], `review.${key}`)
      if (value.formatVersion !== 1) throw new TypeError('review.formatVersion must be 1')
      assertSha256(value.bundleSha256, 'review.bundleSha256')
      assertTimestamp(value.startedAt, 'review.startedAt')
      assertTimestamp(value.completedAt, 'review.completedAt')
      assertEnum(value.disposition, ['complete', 'partial', 'failed'], 'review.disposition')
      assertOptionalString(value, 'failureReason', 'review')
      assertIdentity(value.reviewId, path.reviewId, 'review.reviewId')
      break
    }
    case 'ledger':
      assertRecordId(value.reviewId, 'ledger.reviewId')
      assertArray(value.entries, 'ledger.entries')
      value.entries.forEach((entry, index) => {
        const label = `ledger.entries[${index}]`
        assertRecord(entry, label)
        assertExactKeys(entry, ['entryId', 'kind', 'summary', 'evidence'], label)
        requireFields(entry, ['entryId', 'kind', 'summary', 'evidence'], label)
        assertRecordId(entry.entryId, `${label}.entryId`)
        assertEnum(entry.kind, ['decision', 'finding', 'summary'], `${label}.kind`)
        assertString(entry.summary, `${label}.summary`)
        assertArray(entry.evidence, `${label}.evidence`)
        entry.evidence.forEach((citation, citationIndex) => {
          const citationLabel = `${label}.evidence[${citationIndex}]`
          assertRecord(citation, citationLabel)
          assertExactKeys(citation, ['object', 'locator'], citationLabel)
          requireFields(citation, ['object'], citationLabel)
          assertObjectRef(citation.object, `${citationLabel}.object`)
          if ('locator' in citation) assertString(citation.locator, `${citationLabel}.locator`)
        })
      })
      assertIdentity(value.reviewId, path.reviewId, 'ledger.reviewId')
      break
    case 'coverage':
      assertRecordId(value.actionId, 'coverage.actionId')
      assertRecordId(value.reviewId, 'coverage.reviewId')
      assertArray(value.acceptedLimitations, 'coverage.acceptedLimitations')
      value.acceptedLimitations.forEach((code, index) =>
        assertEnum(code, [...LIMITATION_CODES], `coverage.acceptedLimitations[${index}]`),
      )
      assertWatermarks(value.settledWatermarks, 'coverage.settledWatermarks')
      assertTimestamp(value.createdAt, 'coverage.createdAt')
      assertIdentity(value.actionId, path.actionId, 'coverage.actionId')
      break
    case 'decisionObservation':
      assertRecordId(value.observationId, 'decisionObservation.observationId')
      assertRecordId(value.reviewId, 'decisionObservation.reviewId')
      assertRecordId(value.reviewEntryId, 'decisionObservation.reviewEntryId')
      canonicalJson(value.subject)
      assertString(value.summary, 'decisionObservation.summary')
      assertBoolean(value.canonicalBranch, 'decisionObservation.canonicalBranch')
      assertEnum(value.confidence, ['low', 'medium', 'high'], 'decisionObservation.confidence')
      assertTimestamp(value.observedAt, 'decisionObservation.observedAt')
      assertIdentity(value.observationId, path.observationId, 'decisionObservation.observationId')
      break
    case 'decisionAction':
      assertRecordId(value.actionId, 'decisionAction.actionId')
      assertEnum(
        value.kind,
        ['confirm', 'reject', 'dispute', 'resolve', 'supersede'],
        'decisionAction.kind',
      )
      assertRecordIdArray(value.observationIds, 'decisionAction.observationIds')
      if (value.observationIds.length === 0) {
        throw new TypeError('decisionAction.observationIds must not be empty')
      }
      assertRecord(value.actor, 'decisionAction.actor')
      if (value.actor.kind === 'review') {
        assertExactKeys(value.actor, ['kind', 'reviewId'], 'decisionAction.actor')
        requireFields(value.actor, ['kind', 'reviewId'], 'decisionAction.actor')
        assertRecordId(value.actor.reviewId, 'decisionAction.actor.reviewId')
      } else if (value.actor.kind === 'human') {
        assertExactKeys(value.actor, ['kind', 'label'], 'decisionAction.actor')
        if ('label' in value.actor) assertString(value.actor.label, 'decisionAction.actor.label')
      } else throw new TypeError('decisionAction.actor.kind is unsupported')
      assertTimestamp(value.createdAt, 'decisionAction.createdAt')
      assertOptionalString(value, 'note', 'decisionAction')
      assertIdentity(value.actionId, path.actionId, 'decisionAction.actionId')
      break
  }
  assertNoMachinePaths(value)
}

/** Validate the exact top-level schema selected by an owned record path. */
export function validatePublicRecord(path: OwnedPath, value: unknown): void {
  const selected = parseRecordPath(path)
  if (selected.kind === 'response') {
    if (typeof value !== 'string') throw new TypeError('review response must be UTF-8 text')
    return
  }
  if (selected.kind === 'envelope') {
    assertRecord(value, 'evidence envelope')
    assertExactKeys(value, ['sequence', 'observedAt', 'raw', 'parsed'], 'evidence envelope')
    requireFields(value, ['sequence', 'observedAt', 'raw'], 'evidence envelope')
    assertNonNegativeInteger(value.sequence, 'evidence envelope sequence')
    assertTimestamp(value.observedAt, 'evidence envelope observedAt')
    assertObjectRef(value.raw, 'evidence envelope raw')
    if ('parsed' in value) canonicalJson(value.parsed)
    if (!['codex', 'claude'].includes(selected.provider))
      throw new TypeError('evidence envelope path provider is unsupported')
    return
  }
  validateRecordShape(selected, value)
}
