import { createHash, randomBytes } from 'node:crypto'

export const FACTORY_FORMAT_VERSION = 1 as const
export const FACTORY_READER_VERSION = '0.1.0' as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** Portable identity shared by clones that retain the same Factory history. */
export type RepositoryId = `repo_${string}`
/** Stable GitHub/GHES host plus provider repository identity, safe as one path segment. */
export type GithubRepositoryKey = `ghr_${string}`
/** GitHub owner/name locator grammar shared by provider parsing and public validation. */
export function isGithubRepositoryLocator(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
}
/** Git's portable branch-name grammar, without consulting mutable repository state. */
export function isGitBranchName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value === 'HEAD' ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    [...value].some(character => {
      const code = character.codePointAt(0)!
      return code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(character)
    })
  ) {
    return false
  }
  return value
    .split('/')
    .every(component => !component.startsWith('.') && !component.endsWith('.lock'))
}
/** Canonical stable GitHub identity: normalized host plus provider repository node ID. */
export function githubRepositoryKey(
  hostname: string,
  providerRepositoryId: string,
): GithubRepositoryKey {
  if (
    hostname.length > 253 ||
    !hostname
      .split('.')
      .every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  ) {
    throw new TypeError('GitHub hostname is invalid')
  }
  if (providerRepositoryId.length === 0) throw new TypeError('GitHub repository identity is empty')
  const digest = createHash('sha256')
    .update(`${hostname.toLowerCase()}\0${providerRepositoryId}`)
    .digest('hex')
  return `ghr_${digest}`
}
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
  | 'unavailable-pull-request-code'
  | 'incomplete-pull-request-commits'
  | 'incomplete-pull-request-refs'
  | 'unverified-object'
  | 'excluded-by-limit'
  | 'corrupt-input'
  | 'invalid-review-output'

export type Limitation = {
  code: LimitationCode
  detail: string
  object?: ObjectRef
}

export const EVIDENCE_OMISSION_REASONS = [
  'env-source',
  'unsupported-text',
  'sensitive-path',
  'unsafe-symlink',
  'nontext-attachment',
  'malformed-record',
  'json-key-collision',
] as const

export type EvidenceTransformation = {
  policy: 'evidence-sanitization-1'
  redacted: boolean
  omittedCharacters: number
  omissionReasons: readonly (typeof EVIDENCE_OMISSION_REASONS)[number][]
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

/** Exact effective reviewer identity pinned by plans and immutable reviews. */
export type ResolvedReviewerSettings = {
  provider: 'codex' | 'claude'
  model: string
  effort: string
}

/** Repository policy may defer reviewer resolution until a review is created. */
export type ConfiguredReviewer = 'auto' | (ReviewerSettings & Record<string, JsonValue>)

/** The only mutable public record; unknown keys survive read-modify-write. */
export type RepositoryConfig = Record<string, JsonValue> & {
  canonicalBranch?: string
  reviewer?: ConfiguredReviewer
  automaticReview?: boolean
  dockerLimits?: Partial<DockerLimits>
  updateChecks?: boolean
  reviewLimits?: Record<string, JsonValue> & {
    maxBundleBytes?: number
    maxSessions?: number
  }
}

/** Resource ceilings are configurable; mount and privilege isolation is not. */
export type DockerLimits = { memoryMiB: number; cpus: number; pids: number; timeoutSeconds: number }

export const DEFAULT_DOCKER_LIMITS: Readonly<DockerLimits> = {
  memoryMiB: 2048,
  cpus: 2,
  pids: 256,
  timeoutSeconds: 600,
}

export function parseDockerLimits(value: unknown): Partial<DockerLimits> {
  assertRecord(value, 'dockerLimits')
  const bounds = {
    memoryMiB: [128, 65536],
    cpus: [1, 64],
    pids: [32, 4096],
    timeoutSeconds: [1, 3600],
  } as const
  assertExactKeys(value, Object.keys(bounds), 'dockerLimits')
  for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
    const limit = value[key]
    if (
      limit !== undefined &&
      (typeof limit !== 'number' ||
        !Number.isSafeInteger(limit) ||
        limit < minimum ||
        limit > maximum)
    )
      throw new TypeError(`dockerLimits.${key} must be an integer from ${minimum} to ${maximum}`)
  }
  return value as Partial<DockerLimits>
}

/** Complete validated input for rebuildable read projections. */
export type RepositoryRecords = {
  /** Mutable policy is part of the observed snapshot because it changes derived views. */
  config: RepositoryConfig
  /** Content-addressed object bytes stay behind narrow readers and are never projected wholesale. */
  records: readonly { path: OwnedPath; value: JsonValue | string }[]
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
  evidence: ObjectRef
  transformation?: EvidenceTransformation
}

export type EvidenceEnvelope = {
  sequence: number
  observedAt: string
  evidence: ObjectRef
  transformation?: EvidenceTransformation
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
  evidenceObjects: readonly ObjectRef[]
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
  transformation?: EvidenceTransformation
}

/** Review source bytes, captured without Git worktree conversion. */
export type CodeManifestEntry =
  | {
      path: EncodedGitPath
      mode: '100644' | '100755'
      kind: 'file' | 'lfs-pointer'
      object: ObjectRef
      transformation?: EvidenceTransformation
    }
  | {
      path: EncodedGitPath
      mode: '120000'
      kind: 'symlink'
      object: ObjectRef
      transformation?: EvidenceTransformation
    }
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
  transformation?: EvidenceTransformation
}

export type PullRequestGitRef = {
  repositoryKey: GithubRepositoryKey
  externalId: string
  /** Owner/name locator observed with this immutable provider snapshot. */
  repository: string
  ref: string
  sha: string
}

export type PartialPullRequestGitRef = {
  repositoryKey?: GithubRepositoryKey
  externalId?: string
  /** Owner/name locator observed with this immutable provider snapshot. */
  repository?: string
  ref?: string
  sha?: string
}

type PullRequestObservationBase = {
  transformation?: EvidenceTransformation
  schemaVersion: 1
  observationId: RecordId
  provider: 'github'
  repositoryKey: GithubRepositoryKey
  number: number
  observedAt: string
  limitations: readonly Limitation[]
}

type AvailablePullRequestObservationBase = PullRequestObservationBase & {
  availability: 'available'
  externalId: string
  hostname: string
  url: string
  state: 'open' | 'closed' | 'merged'
  providerUpdatedAt: string
  evidence: readonly ObjectRef[]
  codeAvailability: 'captured' | 'unavailable' | 'not-requested'
  codeManifest?: ObjectRef
  diff: ObjectRef
}

/** A coherent provider snapshot whose commit membership and refs are complete. */
export type CompletePullRequestObservation = AvailablePullRequestObservationBase & {
  completeness: 'complete'
  commitMembership: 'complete'
  base: PullRequestGitRef
  head: PullRequestGitRef
  commits: readonly [string, ...string[]]
}

/** A coherent, reviewable diff with explicitly incomplete commit/ref metadata. */
export type PartialPullRequestObservation = AvailablePullRequestObservationBase & {
  completeness: 'partial'
  commitMembership: 'complete' | 'prefix'
  base: PartialPullRequestGitRef & Pick<PullRequestGitRef, 'repositoryKey' | 'repository'>
  head: PartialPullRequestGitRef
  /** Exact observed prefix only; never a membership set. */
  commits: readonly string[]
}

export type AvailablePullRequestObservation =
  | CompletePullRequestObservation
  | PartialPullRequestObservation

/** Failed or incoherent reads preserve evidence without exposing partial fields as exact. */
export type PullRequestUnavailableReason =
  | 'gh-missing'
  | 'authentication-required'
  | 'not-found'
  | 'command-failed'
  | 'command-timeout'
  | 'output-limit'
  | 'invalid-response'
  | 'observation-changed'

export type UnavailablePullRequestObservation = PullRequestObservationBase & {
  availability: 'unavailable'
  reason: PullRequestUnavailableReason
  hostname: string
  base: Pick<PullRequestGitRef, 'repositoryKey' | 'externalId' | 'repository'>
  evidence: readonly [ObjectRef, ...ObjectRef[]]
}

export type PullRequestObservation =
  | AvailablePullRequestObservation
  | UnavailablePullRequestObservation

/** Provider-derived link from one portable Factory repository to one GitHub repository identity. */
export type GithubRepositoryMappingObservation = {
  transformation?: EvidenceTransformation
  schemaVersion: 1
  observationId: RecordId
  provider: 'github'
  repositoryId: RepositoryId
  repositoryKey: GithubRepositoryKey
  externalId: string
  hostname: string
  repository: string
  url: string
  observedAt: string
  evidence: readonly ObjectRef[]
}

export type AssociationBatch = {
  schemaVersion: 1
  batchId: RecordId
  provider: 'github'
  repositoryKey: GithubRepositoryKey
  number: number
  pullRequestObservationId: RecordId
  kind: 'automatic' | 'manual'
  evidence: readonly { evidenceId: RecordId; sha256: Sha256 }[]
  sourceObservationIds: readonly RecordId[]
  observedAt: string
  policyVersion: string
}

type SessionPullRequestAssociationBase = {
  schemaVersion: 1
  evidenceId: RecordId
  sessionKey: string
  pullRequestObservationId: RecordId
  observedAt: string
}

export type ExactCommitAssociation = SessionPullRequestAssociationBase & {
  kind: 'commit'
  strength: 'verified'
  shas: readonly [string, ...string[]]
  repositoryIdentity: 'same' | 'different' | 'unavailable'
  sourceObservationIds: readonly [RecordId, ...RecordId[]]
}
export type ExactHeadAssociation = SessionPullRequestAssociationBase & {
  kind: 'head'
  strength: 'verified'
  shas: readonly [string]
  repositoryIdentity: 'same' | 'different' | 'unavailable'
  sourceObservationIds: readonly [RecordId, ...RecordId[]]
}
export type VerifiedCodeStateContinuityAssociation = SessionPullRequestAssociationBase & {
  kind: 'code-state-continuity'
  strength: 'verified'
  shas: readonly [string, ...string[]]
  repositoryIdentity: 'same' | 'different' | 'unavailable'
  sourceObservationIds: readonly [RecordId, ...RecordId[]]
}
export type ManualAssociationEvidence = SessionPullRequestAssociationBase & {
  kind: 'manual'
  strength: 'asserted'
  shas: readonly []
  repositoryIdentity: 'unavailable'
  sourceObservationIds: readonly []
  assertion: { actor: string; reason: string }
}
export type PullRequestAssociationInvalidation = SessionPullRequestAssociationBase & {
  kind: 'invalidation'
  strength: 'verified'
  shas: readonly [string, ...string[]]
  repositoryIdentity: 'same' | 'different' | 'unavailable'
  sourceObservationIds: readonly []
  invalidates: RecordId
}
export type SessionPullRequestAssociation =
  | ExactCommitAssociation
  | ExactHeadAssociation
  | VerifiedCodeStateContinuityAssociation
  | ManualAssociationEvidence
  | PullRequestAssociationInvalidation

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

/** Exact per-trigger attempt history; coverage folds never infer holes from a high watermark. */
type ReviewEvidenceSelectionBase = {
  triggerId: RecordId
  /** Whether readable content from this selection is fed to the reviewer. */
  selectedForReview: boolean
  /** Coverage semantics are explicit and never inferred from reason strings. */
  coverageEffect:
    | 'eligible-included'
    | 'eligible-gap'
    | 'context-only'
    | 'previously-analyzed-complete'
    | 'previously-analyzed-partial'
    | 'settled'
    | 'out-of-scope'
    | 'deferred-by-limit'
  classification:
    | 'included'
    | 'readable-partial'
    | 'unavailable'
    | 'corrupt'
    | 'unsafe'
    | 'excluded'
    | 'weak-context'
  reason: string
  limitations: readonly Limitation[]
  association?: {
    proofs: readonly {
      batchId: RecordId
      evidenceId: RecordId
      authority: 'verified-exact' | 'manual-asserted'
    }[]
  }
}

/** Exact per-trigger attempt history; coverage folds never infer holes from a high watermark. */
export type ReviewEvidenceSelection = ReviewEvidenceSelectionBase &
  (
    | {
        kind: 'range'
        sessionKey: string
        turnId: RecordId
        evidenceWatermark: number
      }
    | { kind: 'opaque-problem' }
  )

export type ReviewInputProblem =
  | {
      kind: 'association-batch'
      problemId: Sha256
      path: OwnedPath
      classification: 'unavailable' | 'unsafe' | 'corrupt'
      limitation: Limitation
    }
  | {
      kind: 'subject-object'
      problemId: Sha256
      field: 'codeManifest' | 'stagedPatch' | 'unstagedPatch' | 'raw' | 'limitation'
      object: ObjectRef
      classification: 'unavailable' | 'unsafe' | 'corrupt' | 'excluded'
      limitation: Limitation
    }

export function reviewInputProblemId(problem: Omit<ReviewInputProblem, 'problemId'>): Sha256 {
  return createHash('sha256').update(canonicalJson(problem)).digest('hex') as Sha256
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
  /** Highest exact prefix boundary this review can settle after prior-analysis closure. */
  coverageTargetWatermarks: Readonly<Record<string, number>>
  /** Semantic subject bytes/state, excluding observation IDs and timestamps. */
  subjectFingerprint: Sha256
  subjectAttempt: {
    fingerprint: Sha256
    coverageId: Sha256
    effect: 'current-included' | 'reviewed-partial' | 'previously-analyzed-unsettled' | 'settled'
    limitations: readonly Limitation[]
  }
  /** Durable exact attempt/classification history used after process restart. */
  evidenceSelections: readonly ReviewEvidenceSelection[]
  inputProblems: readonly ReviewInputProblem[]
  triggerIds: readonly RecordId[]
  associationBatchIds: readonly RecordId[]
  priorLedger?: ObjectRef
  limitations: readonly Limitation[]
  reviewer: ResolvedReviewerSettings
  analyzerVersion: string
  promptVersion: string
  policyVersion: string
  formatVersion: 1
  bundleSha256: Sha256
  containerImageDigest: string
  providerCliVersion: string | null
  hostPlatform: string
  startedAt: string
  completedAt: string
  disposition: 'complete' | 'partial' | 'failed'
  failureReason?: ReviewFailureReason
}

export type ReviewFailureReason =
  | 'authentication-unavailable'
  | 'docker-unavailable'
  | 'reviewer-timeout'
  | 'reviewer-cancelled'
  | 'reviewer-crashed'
  | 'invalid-review-output'
  | 'reviewer-output-empty'

export type ReviewLedger = {
  schemaVersion: 1
  reviewId: RecordId
  entries: readonly ChoiceAuditEntry[]
  summary?: ChoiceAuditSummary
}

export type AuditEvidence = readonly { object: ObjectRef; locator?: string }[]

export type ChoiceAuditSubmission = {
  choiceKey: string
  effect: 'assert' | 'remove' | 'contradict'
  assertion: JsonValue
  when: string
  headline: string
  scenario: string
  gap: string
  reach: string
  rationale: string
  confidence: 'low' | 'medium' | 'high'
  evidence: AuditEvidence
} & (
  | { verdict: 'sound' }
  | { verdict: 'unsound'; correctedDecision: string }
  | { verdict: 'needs-user'; provisionalCall: string; reversal: string }
)

export type ChoiceAuditEntry = ChoiceAuditSubmission & { entryId: RecordId }

export type ChoiceAuditSummary = {
  reviewed: string
  trivialDiscretionCount?: number
  noChoiceRationale?: string
  evidence: AuditEvidence
}

export type ChoiceAuditEvent =
  | { kind: 'choice'; choice: ChoiceAuditSubmission }
  | { kind: 'audit-summary'; summary: ChoiceAuditSummary }
  | { kind: 'finish' }

export function validateChoiceAuditEvent(value: unknown): asserts value is ChoiceAuditEvent {
  assertRecord(value, 'audit event')
  if (value.kind === 'choice') {
    assertExactKeys(value, ['kind', 'choice'], 'audit event')
    validateChoiceAuditSubmission(value.choice)
  } else if (value.kind === 'audit-summary') {
    assertExactKeys(value, ['kind', 'summary'], 'audit event')
    validateChoiceAuditSummary(value.summary)
  } else if (value.kind === 'finish') assertExactKeys(value, ['kind'], 'audit event')
  else throw new TypeError('unsupported audit event')
}

/** Presentation ordering is Factory-owned; IDs and evidence order break ties deterministically. */
export function compareChoiceAuditEntries(left: ChoiceAuditEntry, right: ChoiceAuditEntry): number {
  const verdict = { 'needs-user': 0, unsound: 1, sound: 2 }
  const confidence = { low: 0, medium: 1, high: 2 }
  return (
    verdict[left.verdict] - verdict[right.verdict] ||
    confidence[left.confidence] - confidence[right.confidence] ||
    left.choiceKey.localeCompare(right.choiceKey) ||
    left.entryId.localeCompare(right.entryId)
  )
}

function auditText(value: unknown, label: string, limit = 16 * 1024): asserts value is string {
  assertString(value, label)
  if ((value as string).trim().length === 0 || Buffer.byteLength(value as string) > limit)
    throw new TypeError(`${label} must be nonblank and bounded`)
}

function auditEvidence(value: unknown): asserts value is AuditEvidence {
  assertArray(value, 'audit.evidence')
  if (value.length === 0 || value.length > 128)
    throw new TypeError('audit requires bounded citations')
  for (const citation of value) {
    assertRecord(citation, 'audit citation')
    assertExactKeys(citation, ['object', 'locator'], 'audit citation')
    requireFields(citation, ['object'], 'audit citation')
    assertObjectRef(citation.object, 'audit citation object')
    if ('locator' in citation) auditText(citation.locator, 'audit citation locator', 1024)
  }
  const encoded = value.map(item => canonicalJson(item))
  if (
    new Set(encoded).size !== value.length ||
    canonicalJson([...encoded].sort()) !== canonicalJson(encoded)
  )
    throw new TypeError('audit citations must be canonical and unique')
}

export function validateChoiceAuditSubmission(
  value: unknown,
): asserts value is ChoiceAuditSubmission {
  assertRecord(value, 'choice')
  const required = [
    'choiceKey',
    'effect',
    'assertion',
    'when',
    'headline',
    'scenario',
    'gap',
    'reach',
    'verdict',
    'rationale',
    'confidence',
    'evidence',
  ]
  const verdictFields =
    value.verdict === 'unsound'
      ? ['correctedDecision']
      : value.verdict === 'needs-user'
        ? ['provisionalCall', 'reversal']
        : []
  assertExactKeys(value, [...required, ...verdictFields], 'choice')
  requireFields(value, [...required, ...verdictFields], 'choice')
  auditText(value.choiceKey, 'choice.choiceKey', 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.choiceKey as string))
    throw new TypeError('choice.choiceKey is invalid')
  assertEnum(value.effect, ['assert', 'remove', 'contradict'], 'choice.effect')
  canonicalJson(value.assertion)
  if ((value.effect === 'remove') !== (value.assertion === null))
    throw new TypeError('choice assertion must be null exactly for remove')
  assertEnum(value.verdict, ['sound', 'unsound', 'needs-user'], 'choice.verdict')
  assertEnum(value.confidence, ['low', 'medium', 'high'], 'choice.confidence')
  for (const field of ['when', 'scenario', 'gap', 'reach', 'rationale', ...verdictFields])
    auditText(value[field], `choice.${field}`)
  auditText(value.headline, 'choice.headline', 1024)
  if (/[\r\n]/.test(value.headline as string))
    throw new TypeError('choice headline must be one line')
  auditEvidence(value.evidence)
  if (Buffer.byteLength(canonicalJson(value)) > 64 * 1024)
    throw new TypeError('choice exceeds submission bound')
}

export function validateChoiceAuditEntry(value: unknown): asserts value is ChoiceAuditEntry {
  assertRecord(value, 'choice entry')
  const { entryId, ...submission } = value
  assertRecordId(entryId, 'choice entryId')
  validateChoiceAuditSubmission(submission)
}

export function validateChoiceAuditSummary(value: unknown): asserts value is ChoiceAuditSummary {
  assertRecord(value, 'audit summary')
  assertExactKeys(
    value,
    ['reviewed', 'trivialDiscretionCount', 'noChoiceRationale', 'evidence'],
    'audit summary',
  )
  requireFields(value, ['reviewed', 'evidence'], 'audit summary')
  auditText(value.reviewed, 'audit summary.reviewed')
  if ('noChoiceRationale' in value)
    auditText(value.noChoiceRationale, 'audit summary.noChoiceRationale')
  if ('trivialDiscretionCount' in value)
    assertNonNegativeInteger(value.trivialDiscretionCount, 'audit summary.trivialDiscretionCount')
  auditEvidence(value.evidence)
  if (Buffer.byteLength(canonicalJson(value)) > 64 * 1024)
    throw new TypeError('audit summary exceeds submission bound')
}

export type CoverageAction = {
  schemaVersion: 1
  actionId: RecordId
  reviewId: RecordId
  acceptedLimitations: readonly LimitationCode[]
  /** Opaque corrupt/unavailable triggers explicitly acknowledged without inventing a watermark. */
  acceptedTriggerIds: readonly RecordId[]
  /** Exact non-trigger acquisition problems explicitly acknowledged. */
  acceptedProblemIds: readonly Sha256[]
  acceptedSubject?: {
    fingerprint: Sha256
    coverageId: Sha256
    limitations: readonly LimitationCode[]
  }
  settledWatermarks: Readonly<Record<string, number>>
  createdAt: string
}

export type DecisionObservation = ChoiceAuditSubmission & {
  schemaVersion: 1
  observationId: RecordId
  reviewId: RecordId
  reviewEntryId: RecordId
  /** SHA-256 of the canonical effect and assertion, excluding presentation prose. */
  assertionFingerprint: Sha256
  source:
    | { kind: 'workspace'; branch: string | null; exactSnapshot: boolean }
    | {
        kind: 'pull-request'
        provider: 'github'
        repositoryKey: string
        number: number
        observationId: RecordId
      }
  observedAt: string
}

type DecisionActionBase = {
  schemaVersion: 1
  actionId: RecordId
  /** Exact accepted action head observed by the writer; null starts the log. */
  previousActionId: RecordId | null
  actor: { kind: 'review'; reviewId: RecordId } | { kind: 'human'; label?: string }
  /** Fold fingerprint the caller saw; append validation rejects stale requests. */
  expectedStateFingerprint: Sha256
  createdAt: string
}

export type DecisionAction =
  | (DecisionActionBase & {
      kind: 'confirm' | 'reject'
      targetObservationId: RecordId
      note?: string
    })
  | (DecisionActionBase & {
      kind: 'dispute'
      targetObservationId: RecordId
      note: string
    })
  | (DecisionActionBase & { kind: 'resolve'; disputeActionId: RecordId; note: string })
  | (DecisionActionBase & {
      kind: 'supersede'
      fromObservationId: RecordId
      toObservationId: RecordId
      note: string
    })

/** Material equality deliberately excludes wording, verdict, and confidence. */
export function decisionAssertionFingerprint(
  value: Pick<DecisionObservation, 'effect' | 'assertion'>,
): Sha256 {
  return createHash('sha256')
    .update(canonicalJson({ effect: value.effect, assertion: value.assertion }))
    .digest('hex')
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
  if ('dockerLimits' in value) parseDockerLimits(value.dockerLimits)
  if ('updateChecks' in value && typeof value.updateChecks !== 'boolean')
    throw new TypeError('updateChecks must be a boolean')
  if (
    'canonicalBranch' in value &&
    (typeof value.canonicalBranch !== 'string' || !isGitBranchName(value.canonicalBranch))
  ) {
    throw new TypeError('canonicalBranch must be a valid Git branch name')
  }
  if ('automaticReview' in value && typeof value.automaticReview !== 'boolean') {
    throw new TypeError('automaticReview must be a boolean')
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

/** Bind subject coverage to semantic bytes and the exact canonical limitation set. */
export function reviewSubjectCoverageId(
  fingerprint: Sha256,
  limitations: readonly Limitation[],
): Sha256 {
  assertSha256(fingerprint, 'subject coverage fingerprint')
  return createHash('sha256')
    .update(canonicalJson({ fingerprint, limitations }))
    .digest('hex') as Sha256
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
  lifecycle: [
    'schemaVersion',
    'eventId',
    'sessionKey',
    'providerEvent',
    'observedAt',
    'evidence',
    'transformation',
  ],
  turn: [
    'schemaVersion',
    'turnId',
    'sessionKey',
    'nativeStopId',
    'capturedAt',
    'materializedAt',
    'eventRange',
    'transcriptObservations',
    'evidenceObjects',
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
    'transformation',
  ],
  pullRequestObservation: [
    'transformation',
    'schemaVersion',
    'observationId',
    'provider',
    'repositoryKey',
    'number',
    'availability',
    'completeness',
    'commitMembership',
    'externalId',
    'hostname',
    'url',
    'state',
    'base',
    'head',
    'commits',
    'observedAt',
    'providerUpdatedAt',
    'evidence',
    'codeAvailability',
    'codeManifest',
    'diff',
    'reason',
    'limitations',
  ],
  githubRepositoryMapping: [
    'transformation',
    'schemaVersion',
    'observationId',
    'provider',
    'repositoryId',
    'repositoryKey',
    'externalId',
    'hostname',
    'repository',
    'url',
    'observedAt',
    'evidence',
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
    'assertion',
    'observedAt',
  ],
  associationBatch: [
    'schemaVersion',
    'batchId',
    'provider',
    'repositoryKey',
    'number',
    'pullRequestObservationId',
    'kind',
    'evidence',
    'sourceObservationIds',
    'observedAt',
    'policyVersion',
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
    'coverageTargetWatermarks',
    'subjectFingerprint',
    'subjectAttempt',
    'evidenceSelections',
    'inputProblems',
    'triggerIds',
    'associationBatchIds',
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
  ledger: ['schemaVersion', 'reviewId', 'entries', 'summary'],
  coverage: [
    'schemaVersion',
    'actionId',
    'reviewId',
    'acceptedLimitations',
    'acceptedTriggerIds',
    'acceptedProblemIds',
    'acceptedSubject',
    'settledWatermarks',
    'createdAt',
  ],
  decisionObservation: [
    'schemaVersion',
    'observationId',
    'reviewId',
    'reviewEntryId',
    'choiceKey',
    'effect',
    'assertion',
    'assertionFingerprint',
    'when',
    'headline',
    'scenario',
    'gap',
    'reach',
    'verdict',
    'rationale',
    'evidence',
    'correctedDecision',
    'provisionalCall',
    'reversal',
    'source',
    'confidence',
    'observedAt',
  ],
  decisionAction: [
    'schemaVersion',
    'actionId',
    'kind',
    'previousActionId',
    'targetObservationId',
    'disputeActionId',
    'fromObservationId',
    'toObservationId',
    'actor',
    'expectedStateFingerprint',
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
  | {
      kind: 'pullRequestObservation'
      repositoryKey: string
      number: number
      observationId: string
    }
  | {
      kind: 'githubRepositoryMapping'
      repositoryKey: string
      repositoryId: string
      observationId: string
    }
  | {
      kind: 'association'
      repositoryKey: string
      number: number
      observationId: string
      evidenceId: string
    }
  | {
      kind: 'associationBatch'
      repositoryKey: string
      number: number
      observationId: string
      batchId: string
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
      kind: 'auditEvent'
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
  if (match)
    return {
      kind: 'sessionIdentity',
      provider: match[1]!,
      sessionKey: match[2]!,
    }
  match = /^sessions\/([^/]+)\/([^/]+)\/lifecycle\/([^/]+)\.json$/.exec(path)
  if (match)
    return {
      kind: 'lifecycle',
      provider: match[1]!,
      sessionKey: match[2]!,
      eventId: match[3]!,
    }
  match = /^sessions\/([^/]+)\/([^/]+)\/turns\/([^/]+)\/manifest\.json$/.exec(path)
  if (match)
    return {
      kind: 'turn',
      provider: match[1]!,
      sessionKey: match[2]!,
      turnId: match[3]!,
    }
  match = /^sessions\/([^/]+)\/([^/]+)\/turns\/([^/]+)\/(?:events|transcript)\.jsonl$/.exec(path)
  if (match)
    return {
      kind: 'envelope',
      provider: match[1]!,
      sessionKey: match[2]!,
      turnId: match[3]!,
    }
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
  match = /^pull-requests\/github\/([^/]+)\/repository-mappings\/([^/]+)\/([^/]+)\.json$/.exec(path)
  if (match)
    return {
      kind: 'githubRepositoryMapping',
      repositoryKey: match[1]!,
      repositoryId: match[2]!,
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
  match =
    /^pull-requests\/github\/([^/]+)\/([1-9]\d*)\/associations\/([^/]+)\/batches\/([^/]+)\.json$/.exec(
      path,
    )
  if (match)
    return {
      kind: 'associationBatch',
      repositoryKey: match[1]!,
      number: Number(match[2]),
      observationId: match[3]!,
      batchId: match[4]!,
    }
  match = /^review-triggers\/([^/]+)\.json$/.exec(path)
  if (match) return { kind: 'trigger', triggerId: match[1]! }
  match = /^reviews\/workspace\/([^/]+)\/(manifest\.json|ledger\.json|submissions\.jsonl)$/.exec(
    path,
  )
  if (match)
    return {
      kind:
        match[2] === 'manifest.json'
          ? 'review'
          : match[2] === 'ledger.json'
            ? 'ledger'
            : 'auditEvent',
      reviewId: match[1]!,
      subject: { kind: 'workspace' },
    }
  match =
    /^reviews\/pull-requests\/github\/([^/]+)\/([1-9]\d*)\/([^/]+)\/(manifest\.json|ledger\.json|submissions\.jsonl)$/.exec(
      path,
    )
  if (match)
    return {
      kind:
        match[4] === 'manifest.json'
          ? 'review'
          : match[4] === 'ledger.json'
            ? 'ledger'
            : 'auditEvent',
      reviewId: match[3]!,
      subject: {
        kind: 'pull-request',
        repositoryKey: match[1]!,
        number: Number(match[2]),
      },
    }
  match = /^reviews\/coverage-actions\/([^/]+)\.json$/.exec(path)
  if (match) return { kind: 'coverage', actionId: match[1]! }
  match = /^decisions\/observations\/([^/]+)\.json$/.exec(path)
  if (match) return { kind: 'decisionObservation', observationId: match[1]! }
  match = /^decisions\/actions\/([^/]+)\.json$/.exec(path)
  if (match) return { kind: 'decisionAction', actionId: match[1]! }
  throw new TypeError(`path is not a declared Factory v1 record: ${path}`)
}

/** Prove an untrusted string names one declared v1 record before filesystem access. */
export function assertOwnedRecordPath(path: string): asserts path is OwnedPath {
  parseRecordPath(path as OwnedPath)
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
  'unavailable-pull-request-code',
  'incomplete-pull-request-commits',
  'incomplete-pull-request-refs',
  'unverified-object',
  'excluded-by-limit',
  'corrupt-input',
  'invalid-review-output',
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

export function parseEvidenceTransformation(value: unknown): EvidenceTransformation {
  assertRecord(value, 'evidence transformation')
  const keys = ['policy', 'redacted', 'omittedCharacters', 'omissionReasons']
  assertExactKeys(value, keys, 'evidence transformation')
  requireFields(value, keys, 'evidence transformation')
  assertEnum(value.policy, ['evidence-sanitization-1'], 'evidence transformation policy')
  if (typeof value.redacted !== 'boolean')
    throw new TypeError('evidence transformation redacted must be boolean')
  if (!Number.isSafeInteger(value.omittedCharacters) || (value.omittedCharacters as number) < 0)
    throw new TypeError('evidence transformation omittedCharacters must be nonnegative')
  assertArray(value.omissionReasons, 'evidence transformation omissionReasons')
  for (const reason of value.omissionReasons)
    assertEnum(reason, EVIDENCE_OMISSION_REASONS, 'evidence transformation omission reason')
  return value as EvidenceTransformation
}

/** Validate the canonical object payload used to reconstruct a workspace. */
export function parseCodeManifest(value: unknown): CodeManifest {
  assertRecord(value, 'code manifest')
  assertExactKeys(
    value,
    ['schemaVersion', 'entries', 'limitations', 'transformation'],
    'code manifest',
  )
  if ('transformation' in value) parseEvidenceTransformation(value.transformation)
  requireFields(value, ['schemaVersion', 'entries', 'limitations'], 'code manifest')
  if (value.schemaVersion !== 1) throw new TypeError('code manifest schemaVersion must be 1')
  assertArray(value.entries, 'code manifest entries')
  let previous: Buffer | undefined
  const seen = new Set<string>()
  value.entries.forEach((entry, index) => {
    const label = `code manifest entries[${index}]`
    assertRecord(entry, label)
    assertExactKeys(entry, ['path', 'mode', 'kind', 'object', 'gitObject', 'transformation'], label)
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
      if (
        entry.mode !== '160000' ||
        'object' in entry ||
        'transformation' in entry ||
        !('gitObject' in entry)
      ) {
        throw new TypeError(`${label} gitlink shape is invalid`)
      }
      if (
        typeof entry.gitObject !== 'string' ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.gitObject)
      ) {
        throw new TypeError(`${label}.gitObject is invalid`)
      }
    } else {
      if ('transformation' in entry) parseEvidenceTransformation(entry.transformation)
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

function assertReviewer(value: unknown, label: string): asserts value is ResolvedReviewerSettings {
  assertRecord(value, label)
  assertExactKeys(value, ['provider', 'model', 'effort'], label)
  requireFields(value, ['provider', 'model', 'effort'], label)
  assertEnum(value.provider, ['codex', 'claude'], `${label}.provider`)
  assertString(value.model, `${label}.model`)
  assertString(value.effort, `${label}.effort`)
  if (
    (value.model as string).trim().length === 0 ||
    Buffer.byteLength(value.model as string) > 256 ||
    (value.effort as string).trim().length === 0 ||
    Buffer.byteLength(value.effort as string) > 64
  )
    throw new TypeError(`${label} model and effort must be nonblank and bounded`)
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
  path: Exclude<RecordPath, { kind: 'envelope' | 'auditEvent' }>,
  value: unknown,
): void {
  const kind = path.kind
  assertBaseRecord(value, kind)
  const required: Record<RecordKind, readonly string[]> = {
    sessionIdentity: RECORD_KEYS.sessionIdentity,
    lifecycle: RECORD_KEYS.lifecycle.filter(key => key !== 'transformation'),
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
      key => !['codeManifest', 'stagedPatch', 'unstagedPatch', 'transformation'].includes(key),
    ),
    pullRequestObservation: [
      'schemaVersion',
      'observationId',
      'provider',
      'repositoryKey',
      'number',
      'availability',
      'observedAt',
      'limitations',
    ],
    githubRepositoryMapping: RECORD_KEYS.githubRepositoryMapping.filter(
      key => key !== 'transformation',
    ),
    association: RECORD_KEYS.association.filter(key => !['invalidates', 'assertion'].includes(key)),
    associationBatch: RECORD_KEYS.associationBatch,
    trigger: RECORD_KEYS.trigger.filter(key => key !== 'repositoryObservationId'),
    review: RECORD_KEYS.review.filter(
      key => !['head', 'codeManifest', 'priorLedger', 'failureReason'].includes(key),
    ),
    ledger: RECORD_KEYS.ledger.filter(key => key !== 'summary'),
    coverage: RECORD_KEYS.coverage.filter(key => key !== 'acceptedSubject'),
    decisionObservation: RECORD_KEYS.decisionObservation.filter(
      key => !['correctedDecision', 'provisionalCall', 'reversal'].includes(key),
    ),
    decisionAction: [
      'schemaVersion',
      'actionId',
      'kind',
      'previousActionId',
      'actor',
      'expectedStateFingerprint',
      'createdAt',
    ],
  }
  requireFields(value, required[kind], kind)

  switch (kind) {
    case 'sessionIdentity':
      assertEnum(value.provider, ['codex', 'claude'], 'sessionIdentity.provider')
      assertString(value.nativeSessionId, 'sessionIdentity.nativeSessionId')
      assertString(value.sessionKey, 'sessionIdentity.sessionKey')
      assertNonNegativeInteger(value.captureGeneration, 'sessionIdentity.captureGeneration')
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
      assertObjectRef(value.evidence, 'lifecycle.evidence')
      if (value.transformation !== undefined) parseEvidenceTransformation(value.transformation)
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
      assertObjectRefs(value.evidenceObjects, 'turn.evidenceObjects')
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
      if ('transformation' in value) parseEvidenceTransformation(value.transformation)
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
    case 'pullRequestObservation': {
      if ('transformation' in value) parseEvidenceTransformation(value.transformation)
      assertRecordId(value.observationId, 'pullRequestObservation.observationId')
      assertIdentity(value.provider, 'github', 'pullRequestObservation.provider')
      assertString(value.repositoryKey, 'pullRequestObservation.repositoryKey')
      if (!/^ghr_[A-Za-z0-9_-]+$/.test(value.repositoryKey)) {
        throw new TypeError('pullRequestObservation.repositoryKey is invalid')
      }
      assertPositiveInteger(value.number, 'pullRequestObservation.number')
      assertEnum(
        value.availability,
        ['available', 'unavailable'],
        'pullRequestObservation.availability',
      )
      assertTimestamp(value.observedAt, 'pullRequestObservation.observedAt')
      if (value.availability === 'available') {
        assertExactKeys(
          value,
          RECORD_KEYS.pullRequestObservation.filter(key => key !== 'reason'),
          'pullRequestObservation',
        )
        requireFields(
          value,
          [
            'externalId',
            'hostname',
            'url',
            'state',
            'base',
            'head',
            'commits',
            'completeness',
            'commitMembership',
            'providerUpdatedAt',
            'evidence',
            'codeAvailability',
            'diff',
          ],
          'pullRequestObservation',
        )
        assertEnum(value.state, ['open', 'closed', 'merged'], 'pullRequestObservation.state')
        assertEnum(
          value.completeness,
          ['complete', 'partial'],
          'pullRequestObservation.completeness',
        )
        assertEnum(
          value.commitMembership,
          ['complete', 'prefix'],
          'pullRequestObservation.commitMembership',
        )
        if (value.completeness === 'complete' && value.commitMembership !== 'complete') {
          throw new TypeError('complete pullRequestObservation requires complete membership')
        }
        for (const key of ['externalId', 'hostname', 'url']) {
          assertString(value[key], `pullRequestObservation.${key}`)
        }
        if (!/^[A-Za-z0-9.-]+$/.test(value.hostname as string)) {
          throw new TypeError('pullRequestObservation.hostname is invalid')
        }
        let providerUrl: URL
        try {
          providerUrl = new URL(value.url as string)
        } catch {
          throw new TypeError('pullRequestObservation.url is invalid')
        }
        if (
          providerUrl.protocol !== 'https:' ||
          providerUrl.hostname.toLowerCase() !== (value.hostname as string).toLowerCase() ||
          providerUrl.username !== '' ||
          providerUrl.password !== '' ||
          providerUrl.search !== '' ||
          providerUrl.hash !== ''
        ) {
          throw new TypeError('pullRequestObservation.url does not match hostname')
        }
        for (const key of ['base', 'head'] as const) {
          const ref = value[key]
          assertRecord(ref, `pullRequestObservation.${key}`)
          assertExactKeys(
            ref,
            ['repositoryKey', 'externalId', 'repository', 'ref', 'sha'],
            `pullRequestObservation.${key}`,
          )
          if (value.completeness === 'complete' || key === 'base') {
            requireFields(
              ref,
              ['repositoryKey', 'externalId', 'repository'],
              `pullRequestObservation.${key}`,
            )
          }
          if (value.completeness === 'complete') {
            requireFields(ref, ['ref', 'sha'], `pullRequestObservation.${key}`)
          }
          if ('repositoryKey' in ref) {
            assertString(ref.repositoryKey, `pullRequestObservation.${key}.repositoryKey`)
            if (!/^ghr_[A-Za-z0-9_-]+$/.test(ref.repositoryKey)) {
              throw new TypeError(`pullRequestObservation.${key}.repositoryKey is invalid`)
            }
          }
          if ('externalId' in ref) {
            assertString(ref.externalId, `pullRequestObservation.${key}.externalId`)
            if (
              'repositoryKey' in ref &&
              ref.repositoryKey !== githubRepositoryKey(value.hostname as string, ref.externalId)
            ) {
              throw new TypeError(`pullRequestObservation.${key}.repositoryKey is not canonical`)
            }
          }
          for (const field of ['repository', 'ref'] as const) {
            if (field in ref) assertString(ref[field], `pullRequestObservation.${key}.${field}`)
          }
          if ('repository' in ref && !isGithubRepositoryLocator(ref.repository as string)) {
            throw new TypeError(`pullRequestObservation.${key}.repository is invalid`)
          }
          if ('sha' in ref) assertGitObjectIds([ref.sha], `pullRequestObservation.${key}.sha`)
          if (key === 'head' && value.completeness === 'partial') {
            const identityFields = ['repositoryKey', 'externalId', 'repository']
            const present = identityFields.filter(field => field in ref).length
            if (present !== 0 && present !== identityFields.length) {
              throw new TypeError(
                'partial pullRequestObservation head identity must be all-or-none',
              )
            }
          }
        }
        if ((value.base as Record<string, unknown>).repositoryKey !== value.repositoryKey) {
          throw new TypeError('pullRequestObservation base repository must match its owned path')
        }
        if (
          providerUrl.pathname.replace(/\/$/, '') !==
            `/${(value.base as Record<string, unknown>).repository}/pull/${value.number}` ||
          providerUrl.search !== '' ||
          providerUrl.hash !== ''
        ) {
          throw new TypeError('pullRequestObservation.url does not match its PR locator')
        }
        if (
          value.repositoryKey !==
          githubRepositoryKey(
            value.hostname as string,
            (value.base as Record<string, unknown>).externalId as string,
          )
        ) {
          throw new TypeError('pullRequestObservation.repositoryKey is not canonical')
        }
        assertGitObjectIds(value.commits, 'pullRequestObservation.commits')
        const commits = value.commits as string[]
        if (new Set(commits).size !== commits.length) {
          throw new TypeError('pullRequestObservation commits must be unique')
        }
        const observedHead = (value.head as Record<string, unknown>).sha
        if (
          value.commitMembership === 'complete' &&
          (commits.length === 0 ||
            (typeof observedHead === 'string' && !commits.includes(observedHead)))
        ) {
          throw new TypeError('complete pullRequestObservation membership must contain head')
        }
        assertTimestamp(value.providerUpdatedAt, 'pullRequestObservation.providerUpdatedAt')
        assertEnum(
          value.codeAvailability,
          ['captured', 'unavailable', 'not-requested'],
          'pullRequestObservation.codeAvailability',
        )
        assertObjectRefs(value.evidence, 'pullRequestObservation.evidence')
        if ((value.evidence as ObjectRef[]).length === 0) {
          throw new TypeError('pullRequestObservation evidence must not be empty')
        }
        if (
          !(value.evidence as ObjectRef[]).some(
            ref => ref.mediaType === 'application/json' && ref.role === 'github-pr-metadata',
          )
        ) {
          throw new TypeError('pullRequestObservation evidence lacks GitHub metadata')
        }
        assertOptionalObjectRef(value, 'codeManifest', 'pullRequestObservation')
        if (
          'codeManifest' in value &&
          ((value.codeManifest as ObjectRef).mediaType !==
            'application/vnd.factory.code-manifest+json' ||
            (value.codeManifest as ObjectRef).role !== 'workspace-code-manifest')
        ) {
          throw new TypeError('pullRequestObservation code manifest semantics are invalid')
        }
        assertObjectRef(value.diff, 'pullRequestObservation.diff')
        if (
          (value.diff as ObjectRef).mediaType !== 'text/x-diff' ||
          (value.diff as ObjectRef).role !== 'pull-request-diff'
        ) {
          throw new TypeError('pullRequestObservation diff semantics are invalid')
        }
      } else {
        assertExactKeys(
          value,
          [
            'schemaVersion',
            'observationId',
            'provider',
            'repositoryKey',
            'number',
            'availability',
            'reason',
            'hostname',
            'base',
            'observedAt',
            'evidence',
            'limitations',
            'association',
            'transformation',
          ],
          'pullRequestObservation',
        )
        requireFields(value, ['reason', 'hostname', 'base', 'evidence'], 'pullRequestObservation')
        assertEnum(
          value.reason,
          [
            'gh-missing',
            'authentication-required',
            'not-found',
            'command-failed',
            'command-timeout',
            'output-limit',
            'invalid-response',
            'observation-changed',
          ],
          'pullRequestObservation.reason',
        )
        assertString(value.hostname, 'pullRequestObservation.hostname')
        assertRecord(value.base, 'pullRequestObservation.base')
        assertExactKeys(
          value.base,
          ['repositoryKey', 'externalId', 'repository'],
          'pullRequestObservation.base',
        )
        requireFields(
          value.base,
          ['repositoryKey', 'externalId', 'repository'],
          'pullRequestObservation.base',
        )
        for (const key of ['repositoryKey', 'externalId', 'repository']) {
          assertString(value.base[key], `pullRequestObservation.base.${key}`)
        }
        if (!isGithubRepositoryLocator(value.base.repository as string)) {
          throw new TypeError('pullRequestObservation.base.repository is invalid')
        }
        if (value.base.repositoryKey !== value.repositoryKey) {
          throw new TypeError('pullRequestObservation base repository must match its owned path')
        }
        if (
          value.repositoryKey !==
          githubRepositoryKey(value.hostname as string, value.base.externalId as string)
        ) {
          throw new TypeError('pullRequestObservation.repositoryKey is not canonical')
        }
        assertObjectRefs(value.evidence, 'pullRequestObservation.evidence')
        if (
          (value.evidence as ObjectRef[]).length === 0 ||
          !(value.evidence as ObjectRef[]).some(
            ref => ref.mediaType === 'application/json' && ref.role === 'github-pr-metadata',
          )
        ) {
          throw new TypeError(
            'unavailable pullRequestObservation requires GitHub metadata evidence',
          )
        }
      }
      assertLimitations(value.limitations, 'pullRequestObservation.limitations')
      if (value.availability === 'available' && value.completeness === 'partial') {
        const hasAllRefs = ['base', 'head'].every(key => {
          const ref = value[key] as Record<string, unknown>
          return ['repositoryKey', 'externalId', 'repository', 'ref', 'sha'].every(
            field => field in ref,
          )
        })
        if (hasAllRefs && value.commitMembership === 'complete') {
          throw new TypeError('partial pullRequestObservation must identify what is incomplete')
        }
      }
      if (value.availability === 'available' && value.completeness === 'complete') {
        if (
          (value.limitations as Limitation[]).some(item =>
            ['incomplete-pull-request-commits', 'incomplete-pull-request-refs'].includes(item.code),
          )
        ) {
          throw new TypeError('complete pullRequestObservation cannot claim incomplete evidence')
        }
      }
      if (value.availability === 'available') {
        const limitationCodes = new Set((value.limitations as Limitation[]).map(item => item.code))
        if (
          (value.commitMembership === 'prefix') !==
          limitationCodes.has('incomplete-pull-request-commits')
        ) {
          throw new TypeError('commit membership and its limitation must agree')
        }
        const refsComplete = ['base', 'head'].every(key => {
          const ref = value[key] as Record<string, unknown>
          return ['repositoryKey', 'externalId', 'repository', 'ref', 'sha'].every(
            field => field in ref,
          )
        })
        if (!refsComplete !== limitationCodes.has('incomplete-pull-request-refs')) {
          throw new TypeError('pull-request refs and their limitation must agree')
        }
        const hasCode = 'codeManifest' in value
        const hasCodeLimitation = limitationCodes.has('unavailable-pull-request-code')
        if (
          (value.codeAvailability === 'captured' && (!hasCode || hasCodeLimitation)) ||
          (value.codeAvailability === 'unavailable' && (hasCode || !hasCodeLimitation)) ||
          (value.codeAvailability === 'not-requested' && (hasCode || hasCodeLimitation))
        ) {
          throw new TypeError('pull-request code availability and its evidence must agree')
        }
      }
      if (
        value.availability === 'unavailable' &&
        !(value.limitations as Limitation[]).some(item => item.code === 'unavailable-pull-request')
      ) {
        throw new TypeError('unavailable pullRequestObservation requires its limitation')
      }
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
    }
    case 'githubRepositoryMapping': {
      if ('transformation' in value) parseEvidenceTransformation(value.transformation)
      assertRecordId(value.observationId, 'githubRepositoryMapping.observationId')
      assertIdentity(value.provider, 'github', 'githubRepositoryMapping.provider')
      assertString(value.repositoryId, 'githubRepositoryMapping.repositoryId')
      if (!/^repo_[A-Za-z0-9_-]+$/.test(value.repositoryId as string)) {
        throw new TypeError('githubRepositoryMapping.repositoryId is invalid')
      }
      assertString(value.repositoryKey, 'githubRepositoryMapping.repositoryKey')
      if (!/^ghr_[A-Za-z0-9_-]+$/.test(value.repositoryKey as string)) {
        throw new TypeError('githubRepositoryMapping.repositoryKey is invalid')
      }
      for (const key of ['externalId', 'hostname', 'repository', 'url']) {
        assertString(value[key], `githubRepositoryMapping.${key}`)
      }
      if (!isGithubRepositoryLocator(value.repository as string)) {
        throw new TypeError('githubRepositoryMapping.repository is invalid')
      }
      if (!/^[A-Za-z0-9.-]+$/.test(value.hostname as string)) {
        throw new TypeError('githubRepositoryMapping.hostname is invalid')
      }
      let url: URL
      try {
        url = new URL(value.url as string)
      } catch {
        throw new TypeError('githubRepositoryMapping.url is invalid')
      }
      if (
        url.protocol !== 'https:' ||
        url.hostname.toLowerCase() !== (value.hostname as string).toLowerCase() ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== ''
      ) {
        throw new TypeError('githubRepositoryMapping.url does not match hostname')
      }
      if (
        url.pathname.replace(/\/$/, '') !== `/${value.repository}` ||
        url.search !== '' ||
        url.hash !== ''
      ) {
        throw new TypeError('githubRepositoryMapping.url does not match repository locator')
      }
      if (
        value.repositoryKey !==
        githubRepositoryKey(value.hostname as string, value.externalId as string)
      ) {
        throw new TypeError('githubRepositoryMapping.repositoryKey is not canonical')
      }
      assertTimestamp(value.observedAt, 'githubRepositoryMapping.observedAt')
      assertObjectRefs(value.evidence, 'githubRepositoryMapping.evidence')
      if (
        (value.evidence as ObjectRef[]).length === 0 ||
        !(value.evidence as ObjectRef[]).some(
          ref => ref.mediaType === 'application/json' && ref.role === 'github-repository-metadata',
        )
      ) {
        throw new TypeError('githubRepositoryMapping requires repository metadata evidence')
      }
      assertIdentity(
        value.repositoryKey,
        path.repositoryKey,
        'githubRepositoryMapping.repositoryKey',
      )
      assertIdentity(value.repositoryId, path.repositoryId, 'githubRepositoryMapping.repositoryId')
      assertIdentity(
        value.observationId,
        path.observationId,
        'githubRepositoryMapping.observationId',
      )
      break
    }
    case 'association': {
      assertRecordId(value.evidenceId, 'association.evidenceId')
      assertString(value.sessionKey, 'association.sessionKey')
      assertRecordId(value.pullRequestObservationId, 'association.pullRequestObservationId')
      assertEnum(
        value.kind,
        ['commit', 'head', 'code-state-continuity', 'manual', 'invalidation'],
        'association.kind',
      )
      assertEnum(value.strength, ['verified', 'asserted'], 'association.strength')
      assertGitObjectIds(value.shas, 'association.shas')
      assertEnum(
        value.repositoryIdentity,
        ['same', 'different', 'unavailable'],
        'association.repositoryIdentity',
      )
      assertRecordIdArray(value.sourceObservationIds, 'association.sourceObservationIds')
      if ('invalidates' in value) assertRecordId(value.invalidates, 'association.invalidates')
      if ('assertion' in value) {
        assertRecord(value.assertion, 'association.assertion')
        assertExactKeys(value.assertion, ['actor', 'reason'], 'association.assertion')
        requireFields(value.assertion, ['actor', 'reason'], 'association.assertion')
        assertString(value.assertion.actor, 'association.assertion.actor')
        assertString(value.assertion.reason, 'association.assertion.reason')
      }
      if (value.kind === 'manual') {
        if (
          value.strength !== 'asserted' ||
          !('assertion' in value) ||
          'invalidates' in value ||
          (value.shas as unknown[]).length !== 0 ||
          (value.sourceObservationIds as unknown[]).length !== 0
        ) {
          throw new TypeError('manual association shape is invalid')
        }
      } else if (value.kind === 'invalidation') {
        const invalidatedShas = value.shas as string[]
        if (
          value.strength !== 'verified' ||
          !('invalidates' in value) ||
          value.invalidates === value.evidenceId ||
          'assertion' in value ||
          (value.shas as unknown[]).length === 0 ||
          (value.sourceObservationIds as unknown[]).length !== 0
        ) {
          throw new TypeError('invalidation association shape is invalid')
        }
        if (
          new Set(invalidatedShas).size !== invalidatedShas.length ||
          invalidatedShas.join('\0') !== [...invalidatedShas].sort().join('\0')
        ) {
          throw new TypeError('invalidation SHAs must be unique and canonically ordered')
        }
      } else if (
        value.strength !== 'verified' ||
        'assertion' in value ||
        'invalidates' in value ||
        (value.shas as unknown[]).length === 0 ||
        (value.sourceObservationIds as unknown[]).length === 0 ||
        (value.kind === 'head' && (value.shas as unknown[]).length !== 1)
      ) {
        throw new TypeError('verified association shape is invalid')
      }
      assertTimestamp(value.observedAt, 'association.observedAt')
      assertIdentity(
        value.pullRequestObservationId,
        path.observationId,
        'association.pullRequestObservationId',
      )
      assertIdentity(value.evidenceId, path.evidenceId, 'association.evidenceId')
      break
    }
    case 'associationBatch': {
      assertRecordId(value.batchId, 'associationBatch.batchId')
      assertIdentity(value.provider, 'github', 'associationBatch.provider')
      assertString(value.repositoryKey, 'associationBatch.repositoryKey')
      assertPositiveInteger(value.number, 'associationBatch.number')
      assertRecordId(value.pullRequestObservationId, 'associationBatch.pullRequestObservationId')
      assertEnum(value.kind, ['automatic', 'manual'], 'associationBatch.kind')
      assertArray(value.evidence, 'associationBatch.evidence')
      const evidenceIds = new Set<string>()
      for (const [index, entry] of (value.evidence as unknown[]).entries()) {
        const label = `associationBatch.evidence[${index}]`
        assertRecord(entry, label)
        assertExactKeys(entry, ['evidenceId', 'sha256'], label)
        requireFields(entry, ['evidenceId', 'sha256'], label)
        assertRecordId(entry.evidenceId, `${label}.evidenceId`)
        assertSha256(entry.sha256, `${label}.sha256`)
        if (evidenceIds.has(entry.evidenceId as string)) {
          throw new TypeError('associationBatch evidence IDs must be unique')
        }
        evidenceIds.add(entry.evidenceId as string)
      }
      const evidenceOrder = (value.evidence as { evidenceId: string }[]).map(
        entry => entry.evidenceId,
      )
      if (evidenceOrder.join('\0') !== [...evidenceOrder].sort().join('\0')) {
        throw new TypeError('associationBatch evidence must use canonical order')
      }
      assertRecordIdArray(value.sourceObservationIds, 'associationBatch.sourceObservationIds')
      const sourceOrder = value.sourceObservationIds as string[]
      if (
        new Set(sourceOrder).size !== sourceOrder.length ||
        sourceOrder.join('\0') !== [...sourceOrder].sort().join('\0')
      ) {
        throw new TypeError('associationBatch sources must be unique and canonically ordered')
      }
      assertTimestamp(value.observedAt, 'associationBatch.observedAt')
      assertString(value.policyVersion, 'associationBatch.policyVersion')
      assertIdentity(value.repositoryKey, path.repositoryKey, 'associationBatch.repositoryKey')
      assertIdentity(value.number, path.number, 'associationBatch.number')
      assertIdentity(
        value.pullRequestObservationId,
        path.observationId,
        'associationBatch.pullRequestObservationId',
      )
      assertIdentity(value.batchId, path.batchId, 'associationBatch.batchId')
      break
    }
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
      if (
        canonicalJson(
          [...value.patches].sort((left, right) =>
            canonicalJson(left).localeCompare(canonicalJson(right)),
          ),
        ) !== canonicalJson(value.patches) ||
        new Set(value.patches.map(item => canonicalJson(item))).size !== value.patches.length
      )
        throw new TypeError('review.patches must be canonical and unique')
      assertWatermarks(value.sessionWatermarks, 'review.sessionWatermarks')
      assertWatermarks(value.coverageTargetWatermarks, 'review.coverageTargetWatermarks')
      assertSha256(value.subjectFingerprint, 'review.subjectFingerprint')
      assertRecord(value.subjectAttempt, 'review.subjectAttempt')
      assertExactKeys(
        value.subjectAttempt,
        ['fingerprint', 'coverageId', 'effect', 'limitations'],
        'review.subjectAttempt',
      )
      requireFields(
        value.subjectAttempt,
        ['fingerprint', 'coverageId', 'effect', 'limitations'],
        'review.subjectAttempt',
      )
      assertSha256(value.subjectAttempt.fingerprint, 'review.subjectAttempt.fingerprint')
      assertSha256(value.subjectAttempt.coverageId, 'review.subjectAttempt.coverageId')
      assertIdentity(
        value.subjectAttempt.fingerprint,
        value.subjectFingerprint as string,
        'review.subjectAttempt.fingerprint',
      )
      assertEnum(
        value.subjectAttempt.effect,
        ['current-included', 'reviewed-partial', 'previously-analyzed-unsettled', 'settled'],
        'review.subjectAttempt.effect',
      )
      assertLimitations(value.subjectAttempt.limitations, 'review.subjectAttempt.limitations')
      assertIdentity(
        value.subjectAttempt.coverageId,
        reviewSubjectCoverageId(
          value.subjectAttempt.fingerprint as Sha256,
          value.subjectAttempt.limitations as unknown as readonly Limitation[],
        ),
        'review.subjectAttempt.coverageId',
      )
      assertArray(value.evidenceSelections, 'review.evidenceSelections')
      value.evidenceSelections.forEach((selection, index) => {
        const label = `review.evidenceSelections[${index}]`
        assertRecord(selection, label)
        assertExactKeys(
          selection,
          [
            'kind',
            'sessionKey',
            'triggerId',
            'turnId',
            'evidenceWatermark',
            'selectedForReview',
            'coverageEffect',
            'classification',
            'reason',
            'limitations',
            'association',
          ],
          label,
        )
        requireFields(
          selection,
          [
            'kind',
            'triggerId',
            'selectedForReview',
            'coverageEffect',
            'classification',
            'reason',
            'limitations',
          ],
          label,
        )
        assertEnum(selection.kind, ['range', 'opaque-problem'], `${label}.kind`)
        assertRecordId(selection.triggerId, `${label}.triggerId`)
        assertBoolean(selection.selectedForReview, `${label}.selectedForReview`)
        assertEnum(
          selection.coverageEffect,
          [
            'eligible-included',
            'eligible-gap',
            'context-only',
            'previously-analyzed-complete',
            'previously-analyzed-partial',
            'settled',
            'out-of-scope',
            'deferred-by-limit',
          ],
          `${label}.coverageEffect`,
        )
        if (selection.kind === 'range') {
          requireFields(selection, ['sessionKey', 'turnId', 'evidenceWatermark'], label)
          assertString(selection.sessionKey, `${label}.sessionKey`)
          assertRecordId(selection.turnId, `${label}.turnId`)
          assertNonNegativeInteger(selection.evidenceWatermark, `${label}.evidenceWatermark`)
        } else if (
          'sessionKey' in selection ||
          'turnId' in selection ||
          'evidenceWatermark' in selection
        ) {
          throw new TypeError(`${label} opaque problems cannot claim a Session range`)
        }
        assertEnum(
          selection.classification,
          [
            'included',
            'readable-partial',
            'unavailable',
            'corrupt',
            'unsafe',
            'excluded',
            'weak-context',
          ],
          `${label}.classification`,
        )
        assertString(selection.reason, `${label}.reason`)
        assertLimitations(selection.limitations, `${label}.limitations`)
        if ('association' in selection) {
          assertRecord(selection.association, `${label}.association`)
          assertExactKeys(selection.association, ['proofs'], `${label}.association`)
          requireFields(selection.association, ['proofs'], `${label}.association`)
          assertArray(selection.association.proofs, `${label}.association.proofs`)
          if (selection.association.proofs.length === 0)
            throw new TypeError(`${label}.association.proofs must not be empty`)
          selection.association.proofs.forEach((proof, proofIndex) => {
            const proofLabel = `${label}.association.proofs[${proofIndex}]`
            assertRecord(proof, proofLabel)
            assertExactKeys(proof, ['batchId', 'evidenceId', 'authority'], proofLabel)
            requireFields(proof, ['batchId', 'evidenceId', 'authority'], proofLabel)
            assertRecordId(proof.batchId, `${proofLabel}.batchId`)
            assertRecordId(proof.evidenceId, `${proofLabel}.evidenceId`)
            assertEnum(
              proof.authority,
              ['verified-exact', 'manual-asserted'],
              `${proofLabel}.authority`,
            )
          })
          const proofKeys = selection.association.proofs.map(proof => canonicalJson(proof))
          if (
            canonicalJson(
              [...selection.association.proofs].sort((left, right) =>
                canonicalJson(left).localeCompare(canonicalJson(right)),
              ),
            ) !== canonicalJson(selection.association.proofs) ||
            new Set(proofKeys).size !== proofKeys.length
          )
            throw new TypeError(`${label}.association.proofs must be canonical and unique`)
          if (selection.kind !== 'range') {
            throw new TypeError(`${label} opaque problem cannot carry PR association provenance`)
          }
        }
        const legalState =
          (selection.classification === 'included' &&
            selection.selectedForReview === true &&
            selection.coverageEffect === 'eligible-included') ||
          (selection.classification === 'readable-partial' &&
            selection.selectedForReview === true &&
            selection.coverageEffect === 'eligible-gap') ||
          (['unavailable', 'corrupt', 'unsafe'].includes(selection.classification as string) &&
            selection.selectedForReview === false &&
            selection.coverageEffect === 'eligible-gap') ||
          (selection.classification === 'weak-context' &&
            selection.selectedForReview === true &&
            selection.coverageEffect === 'context-only') ||
          (selection.classification === 'excluded' &&
            selection.selectedForReview === false &&
            [
              'previously-analyzed-complete',
              'previously-analyzed-partial',
              'settled',
              'out-of-scope',
              'deferred-by-limit',
            ].includes(selection.coverageEffect as string))
        if (!legalState) throw new TypeError(`${label} has a contradictory selection state`)
        if (
          selection.kind === 'opaque-problem' &&
          (selection.selectedForReview ||
            ['eligible-included', 'context-only'].includes(selection.coverageEffect as string))
        ) {
          throw new TypeError(`${label} opaque problems cannot be reviewed as readable evidence`)
        }
      })
      const evidenceSelections = value.evidenceSelections as unknown as ReviewEvidenceSelection[]
      for (const selection of evidenceSelections) {
        if (value.subject.kind === 'workspace' && selection.association !== undefined) {
          throw new TypeError('workspace review selection forbids PR association provenance')
        }
        if (
          value.subject.kind === 'pull-request' &&
          selection.kind === 'range' &&
          ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect) &&
          selection.association === undefined
        ) {
          throw new TypeError('PR coverage-eligible range requires association provenance')
        }
        if (
          selection.association?.proofs.some(
            proof => !(value.associationBatchIds as unknown as string[]).includes(proof.batchId),
          )
        ) {
          throw new TypeError('review selection association proof names an unpinned batch')
        }
      }
      const orderedSelections = [...evidenceSelections].sort(
        (left, right) =>
          left.triggerId.localeCompare(right.triggerId) || left.kind.localeCompare(right.kind),
      )
      if (canonicalJson(orderedSelections) !== canonicalJson(evidenceSelections)) {
        throw new TypeError('review.evidenceSelections must be canonical and duplicate-free')
      }
      if (
        new Set(evidenceSelections.map(selection => selection.triggerId)).size !==
        evidenceSelections.length
      ) {
        throw new TypeError('review.evidenceSelections contains a duplicate trigger')
      }
      assertArray(value.inputProblems, 'review.inputProblems')
      value.inputProblems.forEach((problem, index) => {
        const label = `review.inputProblems[${index}]`
        assertRecord(problem, label)
        assertEnum(problem.kind, ['association-batch', 'subject-object'], `${label}.kind`)
        assertSha256(problem.problemId, `${label}.problemId`)
        assertLimitations([problem.limitation], `${label}.limitation`)
        if (problem.kind === 'association-batch') {
          assertExactKeys(
            problem,
            ['kind', 'problemId', 'path', 'classification', 'limitation'],
            label,
          )
          assertString(problem.path, `${label}.path`)
          assertOwnedRecordPath(problem.path as OwnedPath)
          assertEnum(
            problem.classification,
            ['unavailable', 'unsafe', 'corrupt'],
            `${label}.classification`,
          )
        } else {
          assertExactKeys(
            problem,
            ['kind', 'problemId', 'field', 'object', 'classification', 'limitation'],
            label,
          )
          assertEnum(
            problem.field,
            ['codeManifest', 'stagedPatch', 'unstagedPatch', 'raw', 'limitation'],
            `${label}.field`,
          )
          assertObjectRef(problem.object, `${label}.object`)
          assertEnum(
            problem.classification,
            ['unavailable', 'unsafe', 'corrupt', 'excluded'],
            `${label}.classification`,
          )
        }
        const { problemId: _problemId, ...payload } = problem
        assertIdentity(
          problem.problemId,
          reviewInputProblemId(payload as Omit<ReviewInputProblem, 'problemId'>),
          `${label}.problemId`,
        )
      })
      const problems = value.inputProblems as unknown as ReviewInputProblem[]
      if (
        canonicalJson(
          [...problems].sort((left, right) =>
            canonicalJson(left).localeCompare(canonicalJson(right)),
          ),
        ) !== canonicalJson(problems) ||
        new Set(problems.map(problem => problem.problemId)).size !== problems.length
      )
        throw new TypeError('review.inputProblems must be canonical and unique')
      if (
        problems.some(
          problem =>
            !(value.limitations as unknown as Limitation[]).some(
              limitation => canonicalJson(limitation) === canonicalJson(problem.limitation),
            ),
        )
      )
        throw new TypeError('review.inputProblems limitations must appear in review.limitations')
      const rangeAttempts = evidenceSelections.filter(
        (
          selection,
        ): selection is ReviewEvidenceSelectionBase &
          Extract<ReviewEvidenceSelection, { kind: 'range' }> =>
          selection.kind === 'range' &&
          ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect),
      )
      const attemptedWatermarks = Object.fromEntries(
        [...new Set(rangeAttempts.map(selection => selection.sessionKey))]
          .sort()
          .map(sessionKey => [
            sessionKey,
            Math.max(
              ...rangeAttempts
                .filter(selection => selection.sessionKey === sessionKey)
                .map(selection => selection.evidenceWatermark),
            ),
          ]),
      )
      if (canonicalJson(attemptedWatermarks) !== canonicalJson(value.sessionWatermarks)) {
        throw new TypeError('review.sessionWatermarks must equal exact attempted ranges')
      }
      const targetSelections = evidenceSelections.filter(
        (
          selection,
        ): selection is ReviewEvidenceSelectionBase &
          Extract<ReviewEvidenceSelection, { kind: 'range' }> =>
          selection.kind === 'range' &&
          [
            'eligible-included',
            'eligible-gap',
            'previously-analyzed-complete',
            'previously-analyzed-partial',
            'settled',
          ].includes(selection.coverageEffect),
      )
      const coverageTargets = Object.fromEntries(
        [...new Set(targetSelections.map(selection => selection.sessionKey))]
          .sort()
          .map(sessionKey => [
            sessionKey,
            Math.max(
              ...targetSelections
                .filter(selection => selection.sessionKey === sessionKey)
                .map(selection => selection.evidenceWatermark),
            ),
          ]),
      )
      if (canonicalJson(coverageTargets) !== canonicalJson(value.coverageTargetWatermarks)) {
        throw new TypeError('review.coverageTargetWatermarks must equal exact prefix closure')
      }
      const attemptedTriggerIds = evidenceSelections
        .filter(selection =>
          ['eligible-included', 'eligible-gap'].includes(selection.coverageEffect),
        )
        .map(selection => selection.triggerId)
        .sort()
      if (canonicalJson(attemptedTriggerIds) !== canonicalJson(value.triggerIds)) {
        throw new TypeError('review.triggerIds must equal exact attempted selections')
      }
      assertRecordIdArray(value.triggerIds, 'review.triggerIds')
      assertRecordIdArray(value.associationBatchIds, 'review.associationBatchIds')
      assertOptionalObjectRef(value, 'priorLedger', 'review')
      assertLimitations(value.limitations, 'review.limitations')
      if (
        canonicalJson(
          [...value.limitations].sort((left, right) =>
            canonicalJson(left).localeCompare(canonicalJson(right)),
          ),
        ) !== canonicalJson(value.limitations) ||
        new Set(value.limitations.map(item => canonicalJson(item))).size !==
          value.limitations.length
      )
        throw new TypeError('review.limitations must be canonical and unique')
      assertReviewer(value.reviewer, 'review.reviewer')
      for (const key of [
        'analyzerVersion',
        'promptVersion',
        'policyVersion',
        'containerImageDigest',
        'hostPlatform',
      ])
        assertString(value[key], `review.${key}`)
      if (value.providerCliVersion !== null)
        assertString(value.providerCliVersion, 'review.providerCliVersion')
      if (value.formatVersion !== 1) throw new TypeError('review.formatVersion must be 1')
      assertSha256(value.bundleSha256, 'review.bundleSha256')
      if (!/^sha256:[0-9a-f]{64}$/.test(value.containerImageDigest as string))
        throw new TypeError('review.containerImageDigest must be an immutable SHA-256 image ID')
      assertTimestamp(value.startedAt, 'review.startedAt')
      assertTimestamp(value.completedAt, 'review.completedAt')
      if (
        new Date(value.completedAt as string).getTime() <
        new Date(value.startedAt as string).getTime()
      )
        throw new TypeError('review.completedAt must not precede review.startedAt')
      assertEnum(value.disposition, ['complete', 'partial', 'failed'], 'review.disposition')
      if ('failureReason' in value)
        assertEnum(
          value.failureReason,
          [
            'authentication-unavailable',
            'docker-unavailable',
            'reviewer-timeout',
            'reviewer-cancelled',
            'reviewer-crashed',
            'invalid-review-output',
            'reviewer-output-empty',
          ],
          'review.failureReason',
        )
      if (value.disposition === 'failed') {
        if (!('failureReason' in value))
          throw new TypeError('failed review requires a failureReason')
      } else if ('failureReason' in value) {
        throw new TypeError('nonfailed review forbids failureReason')
      }
      const selections = value.evidenceSelections as unknown as ReviewEvidenceSelection[]
      if (
        value.disposition === 'complete' &&
        ((value.subjectAttempt as { effect: string }).effect === 'reviewed-partial' ||
          selections.some(selection => selection.coverageEffect === 'eligible-gap') ||
          (value.inputProblems as unknown[]).length > 0 ||
          (value.limitations as unknown[]).length > 0)
      ) {
        throw new TypeError('complete review must be blocker-free')
      }
      if (
        value.disposition === 'partial' &&
        (value.subjectAttempt as { effect: string }).effect !== 'reviewed-partial' &&
        !selections.some(selection => selection.coverageEffect === 'eligible-gap') &&
        (value.limitations as unknown[]).length === 0
      ) {
        throw new TypeError('partial review requires an explicit limitation')
      }
      assertIdentity(value.reviewId, path.reviewId, 'review.reviewId')
      break
    }
    case 'ledger':
      assertRecordId(value.reviewId, 'ledger.reviewId')
      assertArray(value.entries, 'ledger.entries')
      value.entries.forEach(validateChoiceAuditEntry)
      if ('summary' in value) validateChoiceAuditSummary(value.summary)
      if (value.entries.length === 0 && !value.summary)
        throw new TypeError('choice ledger requires a choice or cited summary')
      if (value.entries.length > 500 || Buffer.byteLength(canonicalJson(value)) > 1024 * 1024)
        throw new TypeError('choice ledger exceeds aggregate bound')
      const orderedEntries = [...(value.entries as ChoiceAuditEntry[])].sort(
        compareChoiceAuditEntries,
      )
      if (
        canonicalJson(orderedEntries) !== canonicalJson(value.entries) ||
        new Set(value.entries.map(entry => (entry as ChoiceAuditEntry).entryId)).size !==
          value.entries.length ||
        new Set(value.entries.map(entry => (entry as ChoiceAuditEntry).choiceKey)).size !==
          value.entries.length
      ) {
        throw new TypeError('ledger.entries must be canonical and unique')
      }
      assertIdentity(value.reviewId, path.reviewId, 'ledger.reviewId')
      break
    case 'coverage':
      assertRecordId(value.actionId, 'coverage.actionId')
      assertRecordId(value.reviewId, 'coverage.reviewId')
      assertArray(value.acceptedLimitations, 'coverage.acceptedLimitations')
      value.acceptedLimitations.forEach((code, index) =>
        assertEnum(code, [...LIMITATION_CODES], `coverage.acceptedLimitations[${index}]`),
      )
      assertRecordIdArray(value.acceptedTriggerIds, 'coverage.acceptedTriggerIds')
      assertArray(value.acceptedProblemIds, 'coverage.acceptedProblemIds')
      value.acceptedProblemIds.forEach((id, index) =>
        assertSha256(id, `coverage.acceptedProblemIds[${index}]`),
      )
      if (
        canonicalJson([...value.acceptedLimitations].sort()) !==
          canonicalJson(value.acceptedLimitations) ||
        new Set(value.acceptedLimitations).size !== value.acceptedLimitations.length ||
        canonicalJson([...value.acceptedTriggerIds].sort()) !==
          canonicalJson(value.acceptedTriggerIds) ||
        new Set(value.acceptedTriggerIds).size !== value.acceptedTriggerIds.length ||
        canonicalJson([...value.acceptedProblemIds].sort()) !==
          canonicalJson(value.acceptedProblemIds) ||
        new Set(value.acceptedProblemIds).size !== value.acceptedProblemIds.length
      )
        throw new TypeError('coverage acceptance arrays must be canonical and unique')
      if ('acceptedSubject' in value) {
        assertRecord(value.acceptedSubject, 'coverage.acceptedSubject')
        assertExactKeys(
          value.acceptedSubject,
          ['fingerprint', 'coverageId', 'limitations'],
          'coverage.acceptedSubject',
        )
        requireFields(
          value.acceptedSubject,
          ['fingerprint', 'coverageId', 'limitations'],
          'coverage.acceptedSubject',
        )
        assertSha256(value.acceptedSubject.fingerprint, 'coverage.acceptedSubject.fingerprint')
        assertSha256(value.acceptedSubject.coverageId, 'coverage.acceptedSubject.coverageId')
        assertArray(value.acceptedSubject.limitations, 'coverage.acceptedSubject.limitations')
        value.acceptedSubject.limitations.forEach((code, index) =>
          assertEnum(code, [...LIMITATION_CODES], `coverage.acceptedSubject.limitations[${index}]`),
        )
        if (
          canonicalJson([...value.acceptedSubject.limitations].sort()) !==
            canonicalJson(value.acceptedSubject.limitations) ||
          new Set(value.acceptedSubject.limitations).size !==
            value.acceptedSubject.limitations.length
        )
          throw new TypeError('coverage subject limitations must be canonical and unique')
      }
      assertWatermarks(value.settledWatermarks, 'coverage.settledWatermarks')
      assertTimestamp(value.createdAt, 'coverage.createdAt')
      assertIdentity(value.actionId, path.actionId, 'coverage.actionId')
      break
    case 'decisionObservation':
      {
        validateChoiceAuditSubmission(
          Object.fromEntries(
            Object.entries(value).filter(
              ([key]) =>
                ![
                  'schemaVersion',
                  'observationId',
                  'reviewId',
                  'reviewEntryId',
                  'assertionFingerprint',
                  'source',
                  'observedAt',
                ].includes(key),
            ),
          ),
        )
      }
      assertRecordId(value.observationId, 'decisionObservation.observationId')
      assertRecordId(value.reviewId, 'decisionObservation.reviewId')
      assertRecordId(value.reviewEntryId, 'decisionObservation.reviewEntryId')
      assertSha256(value.assertionFingerprint, 'decisionObservation.assertionFingerprint')
      if (
        value.assertionFingerprint !==
        decisionAssertionFingerprint({
          effect: value.effect as DecisionObservation['effect'],
          assertion: value.assertion as JsonValue,
        })
      )
        throw new TypeError('decisionObservation.assertionFingerprint must match its assertion')
      assertRecord(value.source, 'decisionObservation.source')
      if (value.source.kind === 'workspace') {
        assertExactKeys(
          value.source,
          ['kind', 'branch', 'exactSnapshot'],
          'decisionObservation.source',
        )
        requireFields(
          value.source,
          ['kind', 'branch', 'exactSnapshot'],
          'decisionObservation.source',
        )
        if (value.source.branch !== null)
          assertString(value.source.branch, 'decisionObservation.source.branch')
        assertBoolean(value.source.exactSnapshot, 'decisionObservation.source.exactSnapshot')
      } else if (value.source.kind === 'pull-request') {
        assertExactKeys(
          value.source,
          ['kind', 'provider', 'repositoryKey', 'number', 'observationId'],
          'decisionObservation.source',
        )
        requireFields(
          value.source,
          ['kind', 'provider', 'repositoryKey', 'number', 'observationId'],
          'decisionObservation.source',
        )
        assertEnum(value.source.provider, ['github'], 'decisionObservation.source.provider')
        assertString(value.source.repositoryKey, 'decisionObservation.source.repositoryKey')
        assertPositiveInteger(value.source.number, 'decisionObservation.source.number')
        assertRecordId(value.source.observationId, 'decisionObservation.source.observationId')
      } else throw new TypeError('decisionObservation.source.kind is unsupported')
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
      if (value.kind === 'confirm' || value.kind === 'reject' || value.kind === 'dispute') {
        assertExactKeys(
          value,
          [
            'schemaVersion',
            'actionId',
            'kind',
            'previousActionId',
            'targetObservationId',
            'actor',
            'expectedStateFingerprint',
            'createdAt',
            'note',
          ],
          'decisionAction',
        )
        assertRecordId(value.targetObservationId, 'decisionAction.targetObservationId')
      } else if (value.kind === 'resolve') {
        assertExactKeys(
          value,
          [
            'schemaVersion',
            'actionId',
            'kind',
            'previousActionId',
            'disputeActionId',
            'actor',
            'expectedStateFingerprint',
            'createdAt',
            'note',
          ],
          'decisionAction',
        )
        assertRecordId(value.disputeActionId, 'decisionAction.disputeActionId')
      } else {
        assertExactKeys(
          value,
          [
            'schemaVersion',
            'actionId',
            'kind',
            'previousActionId',
            'fromObservationId',
            'toObservationId',
            'actor',
            'expectedStateFingerprint',
            'createdAt',
            'note',
          ],
          'decisionAction',
        )
        assertRecordId(value.fromObservationId, 'decisionAction.fromObservationId')
        assertRecordId(value.toObservationId, 'decisionAction.toObservationId')
        if (value.fromObservationId === value.toObservationId)
          throw new TypeError('decisionAction supersede targets must differ')
      }
      if (value.previousActionId !== null)
        assertRecordId(value.previousActionId, 'decisionAction.previousActionId')
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
      assertSha256(value.expectedStateFingerprint, 'decisionAction.expectedStateFingerprint')
      assertOptionalString(value, 'note', 'decisionAction')
      if (['dispute', 'resolve', 'supersede'].includes(value.kind as string) && !('note' in value))
        throw new TypeError(`decisionAction ${value.kind as string} requires a note`)
      assertIdentity(value.actionId, path.actionId, 'decisionAction.actionId')
      break
  }
  assertNoMachinePaths(value)
}

/** Validate the exact top-level schema selected by an owned record path. */
export function validatePublicRecord(path: OwnedPath, value: unknown): void {
  const selected = parseRecordPath(path)
  if (selected.kind === 'auditEvent') {
    validateChoiceAuditEvent(value)
    return
  }
  if (selected.kind === 'envelope') {
    assertRecord(value, 'evidence envelope')
    assertExactKeys(
      value,
      ['sequence', 'observedAt', 'evidence', 'parsed', 'transformation'],
      'evidence envelope',
    )
    requireFields(value, ['sequence', 'observedAt', 'evidence'], 'evidence envelope')
    assertNonNegativeInteger(value.sequence, 'evidence envelope sequence')
    assertTimestamp(value.observedAt, 'evidence envelope observedAt')
    assertObjectRef(value.evidence, 'evidence envelope evidence')
    if (value.transformation !== undefined) parseEvidenceTransformation(value.transformation)
    if ('parsed' in value) canonicalJson(value.parsed)
    if (!['codex', 'claude'].includes(selected.provider))
      throw new TypeError('evidence envelope path provider is unsupported')
    return
  }
  validateRecordShape(selected, value)
}
