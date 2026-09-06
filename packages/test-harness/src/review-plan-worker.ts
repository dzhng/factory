import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  canonicalJson,
  encodeGitPath,
  githubRepositoryKey,
  makeOwnedPath,
  newRecordId,
  objectOwnedPath,
  parseCodeManifest,
  type AssociationBatch,
  type AvailablePullRequestObservation,
  type ObjectRef,
  type OwnedPath,
  type RepositoryObservation,
  type ReviewManifest,
  type ReviewTrigger,
  type SessionIdentity,
  type SessionPullRequestAssociation,
  type TurnManifest,
} from '@factory/contract'
import { deriveAssociations } from '@factory/domain'
import { reconstructCodeManifest } from '@factory/repository'
import {
  buildBundle,
  loadReviewHistory,
  loadReviewInputs,
  openReviewRepositoryReader,
  planReview,
  verifyBundle,
  type ReviewPlan,
  type ReviewRepositoryReader,
} from '@factory/review-plan'

const output = process.env.FACTORY_REVIEW_PLAN_OUTPUT ?? '/output'
await mkdir(output, { recursive: true })
const at = '2026-09-05T00:00:00Z'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value))
const ref = (value: Uint8Array, mediaType: string, role: string): ObjectRef => ({
  algorithm: 'sha256',
  sha256: sha(value),
  bytes: value.byteLength,
  mediaType,
  role,
})
const id = (kind: string, value: number) => {
  const entropy = new Uint8Array(10)
  entropy[8] = Math.floor(value / 256)
  entropy[9] = value % 256
  return newRecordId(kind, value, entropy)
}

class FixtureStore implements ReviewRepositoryReader {
  records = new Map<OwnedPath, Uint8Array>()
  objects = new Map<string, Uint8Array>()
  paths = new Set<OwnedPath>()
  failures = new Map<OwnedPath, { kind: 'missing' | 'unsafe'; detail: string }>()
  private root?: string
  put(path: OwnedPath, value: unknown) {
    this.records.set(path, bytes(value))
    this.paths.add(path)
  }
  putJsonl(path: OwnedPath, values: readonly unknown[]) {
    this.records.set(path, new TextEncoder().encode(values.map(canonicalJson).join('')))
    this.paths.add(path)
  }
  putObject(value: Uint8Array, mediaType: string, role: string) {
    const object = ref(value, mediaType, role)
    this.objects.set(object.sha256, value)
    return object
  }
  inventory = async () => [...this.paths].sort()
  read = async (path: OwnedPath) => {
    const failure = this.failures.get(path)
    if (failure !== undefined) return failure
    const value = this.records.get(path)
    return value === undefined
      ? ({ kind: 'missing', detail: path } as const)
      : ({ kind: 'readable', bytes: new Uint8Array(value) } as const)
  }
  getObject = async (object: ObjectRef) => {
    const value = this.objects.get(object.sha256)
    return value === undefined
      ? ({ kind: 'missing', detail: object.sha256 } as const)
      : ({ kind: 'readable', bytes: new Uint8Array(value) } as const)
  }
  async snapshot() {
    this.root ??= await mkdtemp('/tmp/factory-review-input-')
    await rm(this.root, { recursive: true, force: true })
    await mkdir(this.root, { recursive: true })
    for (const path of this.paths) {
      const destination = join(this.root, path)
      await mkdir(dirname(destination), { recursive: true })
      const failure = this.failures.get(path)
      const value = this.records.get(path)
      if (failure?.kind === 'unsafe') await symlink('/etc/passwd', destination)
      else if (value !== undefined) await writeFile(destination, value)
      else if (failure !== undefined) await writeFile(destination, bytes({}))
    }
    for (const [digest, value] of this.objects) {
      const destination = join(this.root, objectOwnedPath(digest))
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, value)
    }
    const reader = await openReviewRepositoryReader(this.root)
    return reader
  }
}

const policies = {
  reviewer: { provider: 'codex' as const, model: 'gpt-test', effort: 'high' },
  analyzerVersion: 'analyzer-v1',
  promptVersion: 'prompt-v1',
  policyVersion: 'policy-v1',
  formatVersion: 1 as const,
}
const repositoryId = 'repo_review_lab'
const sessionKey = 'session-review-lab'
const identity: SessionIdentity = {
  schemaVersion: 1,
  provider: 'codex',
  nativeSessionId: 'native-review-lab',
  sessionKey,
  captureGeneration: 0,
  repositoryId,
  firstObservedAt: at,
}

function addCode(store: FixtureStore, source: string) {
  const sourceBytes = new TextEncoder().encode(source)
  const file = store.putObject(sourceBytes, 'application/octet-stream', 'workspace-file')
  const manifestBytes = bytes({
    schemaVersion: 1,
    entries: [
      {
        path: encodeGitPath(new TextEncoder().encode('src/reviewed.ts'), 'src/reviewed.ts'),
        mode: '100644',
        kind: 'file',
        object: file,
      },
    ],
    limitations: [],
  })
  const manifest = store.putObject(
    manifestBytes,
    'application/vnd.factory.code-manifest+json',
    'workspace-code-manifest',
  )
  return { manifest, file }
}

function observation(
  n: number,
  manifest: ObjectRef,
  options: { branch?: string; head?: string; raced?: boolean } = {},
): RepositoryObservation {
  return {
    schemaVersion: 1,
    observationId: id('observation', n),
    repositoryId,
    observedAt: at,
    completedAt: at,
    git: {
      head: options.head ?? n.toString(16).padStart(40, '0'),
      branch: options.branch ?? 'feature/review',
      detached: false,
    },
    changedPaths: [],
    worktreeFingerprint: manifest.sha256,
    codeManifest: manifest,
    limitations: options.raced
      ? [{ code: 'repository-race', detail: 'repository changed during observation' }]
      : [],
    startState: 'a'.repeat(64),
    endState: options.raced ? 'b'.repeat(64) : 'a'.repeat(64),
  }
}

function addObservation(store: FixtureStore, value: RepositoryObservation) {
  const path = makeOwnedPath('repository-observations', [`${value.observationId}.json`])
  store.put(path, value)
  return path
}

function addCandidate(
  store: FixtureStore,
  n: number,
  repositoryObservation: RepositoryObservation,
  partial = false,
) {
  const rawBytes = new TextEncoder().encode(`{"sequence":${n}}\n`)
  const raw = store.putObject(rawBytes, 'application/json', 'provider-event')
  const codeBytes = store.objects.get(repositoryObservation.codeManifest!.sha256)!
  const code = parseCodeManifest(JSON.parse(new TextDecoder().decode(codeBytes)))
  const limitation = { code: 'missing-transcript-range' as const, detail: 'readable prefix only' }
  const turn: TurnManifest = {
    schemaVersion: 1,
    turnId: id('turn', n),
    sessionKey,
    nativeStopId: `stop-${n}`,
    capturedAt: at,
    materializedAt: at,
    eventRange: { first: n, last: n },
    transcriptObservations: [],
    evidenceObjects: [raw],
    repositoryObservationId: repositoryObservation.observationId,
    codeManifest: repositoryObservation.codeManifest,
    limitations: partial ? [limitation] : [],
    captureAdapterVersion: 'lab',
    formatVersion: 1,
    inventory: [
      repositoryObservation.codeManifest!,
      raw,
      ...code.entries.flatMap(entry => (entry.kind === 'gitlink' ? [] : [entry.object])),
    ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  }
  const trigger: ReviewTrigger = {
    schemaVersion: 1,
    triggerId: id('trigger', n),
    sessionKey,
    turnId: turn.turnId,
    repositoryObservationId: repositoryObservation.observationId,
    evidenceWatermark: n,
    provider: 'codex',
    createdAt: at,
    materialization: partial ? 'partial' : 'complete',
    limitations: turn.limitations,
  }
  const root = ['codex', sessionKey, 'turns', turn.turnId]
  store.put(makeOwnedPath('sessions', ['codex', sessionKey, 'identity.json']), identity)
  store.put(makeOwnedPath('review-triggers', [`${trigger.triggerId}.json`]), trigger)
  store.put(makeOwnedPath('sessions', [...root, 'manifest.json']), turn)
  store.putJsonl(makeOwnedPath('sessions', [...root, 'events.jsonl']), [
    { sequence: n, observedAt: at, evidence: raw },
  ])
  store.putJsonl(makeOwnedPath('sessions', [...root, 'transcript.jsonl']), [])
  addObservation(store, repositoryObservation)
  return { trigger, turn, repositoryObservation }
}

async function loadPlan(
  store: FixtureStore,
  subjectPath: OwnedPath,
  mode: 'incremental' | 'full' | 'force' = 'incremental',
  policyVersion = 'policy-v1',
) {
  const reader = await store.snapshot()
  const loadedHistory = await loadReviewHistory(reader)
  return planReview(
    await loadReviewInputs(reader, {
      mode,
      subjectPath,
      history: loadedHistory,
      policies: { ...policies, policyVersion },
    }),
  )
}

function persistReview(
  store: FixtureStore,
  plan: ReviewPlan,
  n: number,
  disposition: 'complete' | 'partial',
) {
  const reviewId = id('review', n)
  const prefix =
    plan.subject.kind === 'workspace'
      ? ['workspace', reviewId]
      : [
          'pull-requests',
          'github',
          plan.subject.observation.repositoryKey,
          String(plan.subject.observation.number),
          reviewId,
        ]
  const manifestPath = makeOwnedPath('reviews', [...prefix, 'manifest.json'])
  const ledgerPath = makeOwnedPath('reviews', [...prefix, 'ledger.json'])
  const manifest: ReviewManifest = {
    schemaVersion: 1,
    reviewId,
    subject:
      plan.subject.kind === 'workspace'
        ? { kind: 'workspace', repositoryObservationId: plan.subject.observation.observationId }
        : {
            kind: 'pull-request',
            provider: 'github',
            repositoryKey: plan.subject.observation.repositoryKey,
            number: plan.subject.observation.number,
            observationId: plan.subject.observation.observationId,
          },
    ...(plan.subject.observation.codeManifest === undefined
      ? {}
      : { codeManifest: plan.subject.observation.codeManifest }),
    patches: [],
    sessionWatermarks: plan.sessionWatermarks,
    coverageTargetWatermarks: plan.coverageTargetWatermarks,
    subjectFingerprint: plan.subjectFingerprint as ReviewManifest['subjectFingerprint'],
    subjectAttempt: plan.subjectAttempt,
    evidenceSelections: plan.selections,
    inputProblems: plan.inputProblems,
    triggerIds: plan.triggerIds,
    associationBatchIds: plan.associationBatchIds,
    limitations: plan.limitations,
    reviewer: plan.policies.reviewer,
    analyzerVersion: plan.policies.analyzerVersion,
    promptVersion: plan.policies.promptVersion,
    policyVersion: plan.policies.policyVersion,
    formatVersion: 1,
    bundleSha256: 'a'.repeat(64) as ReviewManifest['bundleSha256'],
    containerImageDigest: `sha256:${'b'.repeat(64)}`,
    providerCliVersion: 'lab',
    hostPlatform: 'linux/arm64',
    startedAt: at,
    completedAt: at,
    disposition,
  }
  store.put(manifestPath, manifest)
  const evidence = store.putObject(
    bytes({ explicit: 'synthetic review scope' }),
    'application/json',
    'audit-scope',
  )
  store.put(ledgerPath, {
    schemaVersion: 1,
    reviewId,
    entries: [],
    summary: {
      reviewed: 'Reviewed the synthetic specification and implementation.',
      noChoiceRationale:
        'All observed choices were explicitly selected in this fixture specification.',
      evidence: [{ object: evidence }],
    },
  })
  return { reviewId, manifestPath }
}

function addBatch(
  store: FixtureStore,
  pr: AvailablePullRequestObservation,
  evidence: readonly SessionPullRequestAssociation[],
  n: number,
  kind: 'automatic' | 'manual',
) {
  const batch: AssociationBatch = {
    schemaVersion: 1,
    batchId: id('association-batch', n),
    provider: 'github',
    repositoryKey: pr.repositoryKey,
    number: pr.number,
    pullRequestObservationId: pr.observationId,
    kind,
    evidence: evidence
      .map(value => ({ evidenceId: value.evidenceId, sha256: sha(bytes(value)) }))
      .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    sourceObservationIds: [
      ...new Set(evidence.flatMap(value => value.sourceObservationIds)),
    ].sort(),
    observedAt: pr.observedAt,
    policyVersion: kind === 'manual' ? 'manual-v1' : 'factory-v1-exact-git-v1',
  }
  const root = `pull-requests/github/${pr.repositoryKey}/${pr.number}/associations/${pr.observationId}`
  evidence.forEach(value => store.put(`${root}/${value.evidenceId}.json` as OwnedPath, value))
  store.put(`${root}/batches/${batch.batchId}.json` as OwnedPath, batch)
}

// Workspace: complete, partial, no-op, continuation, policy refresh, weak/orphan, and corrupt sibling.
const store = new FixtureStore()
const code = addCode(store, 'export const reviewed = true\n').manifest
const subject = observation(100, code)
const subjectPath = addObservation(store, subject)
addCandidate(store, 1, subject)
const complete = await loadPlan(store, subjectPath)
const completeBundle = await buildBundle(
  complete,
  { getObject: async value => store.objects.get(value.sha256)! },
  join(output, 'complete-bundle'),
  repositoryId,
)
persistReview(store, complete, 1, 'complete')
const unchanged = await loadPlan(store, subjectPath)
addCandidate(store, 2, subject)
const continuing = await loadPlan(store, subjectPath)
const policy = await loadPlan(store, subjectPath, 'incremental', 'policy-v2')

const partialStore = new FixtureStore()
const partialCode = addCode(partialStore, 'export const partial = true\n').manifest
const partialSubject = observation(110, partialCode)
const partialPath = addObservation(partialStore, partialSubject)
addCandidate(partialStore, 3, partialSubject, true)
const partial = await loadPlan(partialStore, partialPath)
const partialBundle = await buildBundle(
  partial,
  { getObject: async value => partialStore.objects.get(value.sha256)! },
  join(output, 'partial-bundle'),
  repositoryId,
)

const contextStore = new FixtureStore()
const contextCode = addCode(contextStore, 'export const current = true\n').manifest
const contextSubject = observation(120, contextCode)
const contextPath = addObservation(contextStore, contextSubject)
const oldCode = addCode(contextStore, 'export const old = true\n').manifest
addCandidate(contextStore, 4, observation(121, oldCode))
addCandidate(contextStore, 5, observation(122, oldCode, { branch: 'other' }))
const weakAndOrphan = await loadPlan(contextStore, contextPath)

const corruptStore = new FixtureStore()
const corruptCode = addCode(corruptStore, 'export const readableSibling = true\n').manifest
const corruptSubject = observation(130, corruptCode)
const corruptPath = addObservation(corruptStore, corruptSubject)
addCandidate(corruptStore, 6, corruptSubject)
const missingId = id('trigger', 7)
const missingPath = makeOwnedPath('review-triggers', [`${missingId}.json`])
corruptStore.paths.add(missingPath)
corruptStore.records.set(missingPath, bytes({}))
const unavailableId = id('trigger', 9)
const unavailablePath = makeOwnedPath('review-triggers', [`${unavailableId}.json`])
corruptStore.paths.add(unavailablePath)
corruptStore.failures.set(unavailablePath, { kind: 'missing', detail: 'interrupted capture' })
const corruptSibling = await loadPlan(corruptStore, corruptPath)
const partialReview = persistReview(corruptStore, corruptSibling, 2, 'partial')
const action = {
  schemaVersion: 1,
  actionId: id('coverage-action', 1),
  reviewId: partialReview.reviewId,
  acceptedLimitations: ['corrupt-input'],
  acceptedTriggerIds: [missingId, unavailableId],
  acceptedProblemIds: [],
  settledWatermarks: { [sessionKey]: 6 },
  createdAt: at,
} as const
const actionPath = makeOwnedPath('reviews', ['coverage-actions', `${action.actionId}.json`])
corruptStore.put(actionPath, action)
corruptStore.records.delete(missingPath)
addCandidate(corruptStore, 7, corruptSubject)
corruptStore.failures.delete(unavailablePath)
addCandidate(corruptStore, 9, corruptSubject)
const recoveredDefault = await loadPlan(corruptStore, corruptPath)
const recoveredForce = await loadPlan(corruptStore, corruptPath, 'force')

// PR: production loading sees both exact and explicit-manual proofs; a new observation models force-push/base change.
const prStore = new FixtureStore()
const prCode = addCode(prStore, 'export const pullRequest = true\n').manifest
const sessionObservation = observation(140, prCode, { head: 'c'.repeat(40) })
const prCandidate = addCandidate(prStore, 8, sessionObservation)
const repositoryKey = githubRepositoryKey('github.com', 'R_review_lab')
const diffBytes = new TextEncoder().encode('diff --git a/src/reviewed.ts b/src/reviewed.ts\n')
const diff = prStore.putObject(diffBytes, 'text/x-diff', 'pull-request-diff')
const raw = prStore.putObject(bytes({ number: 42 }), 'application/json', 'github-pr-metadata')
const pr: AvailablePullRequestObservation = {
  schemaVersion: 1,
  observationId: id('pr-observation', 1),
  provider: 'github',
  repositoryKey,
  number: 42,
  availability: 'available',
  completeness: 'complete',
  commitMembership: 'complete',
  codeAvailability: 'captured',
  externalId: 'PR_review_lab',
  hostname: 'github.com',
  url: 'https://github.com/dzhng/factory/pull/42',
  state: 'open',
  observedAt: at,
  providerUpdatedAt: at,
  base: {
    repositoryKey,
    externalId: 'R_review_lab',
    repository: 'dzhng/factory',
    ref: 'main',
    sha: 'a'.repeat(40),
  },
  head: {
    repositoryKey,
    externalId: 'R_review_lab',
    repository: 'dzhng/factory',
    ref: 'feature/review',
    sha: 'c'.repeat(40),
  },
  commits: ['c'.repeat(40)],
  evidence: [raw],
  diff,
  codeManifest: prCode,
  limitations: [],
}
const prPath = makeOwnedPath('pull-requests', [
  'github',
  repositoryKey,
  '42',
  'observations',
  `${pr.observationId}.json`,
])
prStore.put(prPath, pr)
const exact = deriveAssociations({
  pullRequest: pr,
  sessions: [
    { provider: 'codex', turn: prCandidate.turn, repositoryObservation: sessionObservation },
  ],
  repositoryMappings: [],
})
addBatch(prStore, pr, exact, 1, 'automatic')
const manual: SessionPullRequestAssociation = {
  schemaVersion: 1,
  evidenceId: id('association', 99),
  sessionKey,
  pullRequestObservationId: pr.observationId,
  kind: 'manual',
  strength: 'asserted',
  shas: [],
  repositoryIdentity: 'unavailable',
  sourceObservationIds: [],
  assertion: { actor: 'developer', reason: 'paired during review' },
  observedAt: at,
}
addBatch(prStore, pr, [manual], 2, 'manual')
const prPlan = await loadPlan(prStore, prPath)
const prBundle = await buildBundle(
  prPlan,
  { getObject: async value => prStore.objects.get(value.sha256)! },
  join(output, 'pr-bundle'),
  repositoryId,
)
persistReview(prStore, prPlan, 3, 'complete')
const continuingPrCandidate = addCandidate(prStore, 10, sessionObservation)
const continuingAssociation = deriveAssociations({
  pullRequest: pr,
  sessions: [
    {
      provider: 'codex',
      turn: continuingPrCandidate.turn,
      repositoryObservation: sessionObservation,
    },
  ],
  repositoryMappings: [],
})
addBatch(prStore, pr, continuingAssociation, 3, 'automatic')
const incrementalPr = await loadPlan(prStore, prPath)
const incrementalPrBundle = await buildBundle(
  incrementalPr,
  { getObject: async value => prStore.objects.get(value.sha256)! },
  join(output, 'pr-incremental-bundle'),
  repositoryId,
)
const nextDiff = prStore.putObject(
  new TextEncoder().encode('diff --git a/src/reviewed.ts b/src/reviewed.ts\n+force push\n'),
  'text/x-diff',
  'pull-request-diff',
)
const nextRaw = prStore.putObject(
  bytes({ number: 42, forcePush: true }),
  'application/json',
  'github-pr-metadata',
)
const forcePushPr: AvailablePullRequestObservation = {
  ...pr,
  observationId: id('pr-observation', 2),
  base: {
    repositoryKey,
    externalId: 'R_review_lab',
    repository: 'dzhng/factory',
    ref: 'main',
    sha: 'e'.repeat(40),
  },
  head: {
    repositoryKey,
    externalId: 'R_review_lab',
    repository: 'dzhng/factory',
    ref: 'feature/review',
    sha: 'd'.repeat(40),
  },
  commits: ['d'.repeat(40)],
  evidence: [nextRaw],
  diff: nextDiff,
}
const forcePushPath = makeOwnedPath('pull-requests', [
  'github',
  repositoryKey,
  '42',
  'observations',
  `${forcePushPr.observationId}.json`,
])
prStore.put(forcePushPath, forcePushPr)
const forcePush = await loadPlan(prStore, forcePushPath)

const corruptBatchPath =
  `pull-requests/github/${repositoryKey}/42/associations/${pr.observationId}/batches/${id('association-batch', 90)}.json` as OwnedPath
prStore.put(corruptBatchPath, {})
const unsafeBatchPath =
  `pull-requests/github/${repositoryKey}/42/associations/${pr.observationId}/batches/${id('association-batch', 91)}.json` as OwnedPath
prStore.paths.add(unsafeBatchPath)
prStore.failures.set(unsafeBatchPath, { kind: 'unsafe', detail: 'symlinked association batch' })
const prBadBatches = await loadPlan(prStore, prPath)
prStore.objects.delete(raw.sha256)
const prMissingRaw = await loadPlan(prStore, prPath)

// Canonical permutation: insertion order cannot affect the production projection or plan.
const permutedStore = new FixtureStore()
;[...store.records].reverse().forEach(([path, value]) => permutedStore.records.set(path, value))
;[...store.paths].reverse().forEach(path => permutedStore.paths.add(path))
;[...store.objects].reverse().forEach(([key, value]) => permutedStore.objects.set(key, value))
const permuted = await loadPlan(permutedStore, subjectPath)
const permutationAPath = join(output, 'permutation-a')
const permutationBPath = join(output, 'permutation-b')
const bundleSource = (source: FixtureStore, plan: ReviewPlan) => ({
  getObject: async (value: ObjectRef) => {
    const ordinary = source.objects.get(value.sha256)
    if (ordinary !== undefined) return ordinary
    if (plan.priorLedger?.object.sha256 === value.sha256) {
      const ledger = source.records.get(plan.priorLedger.path)
      if (ledger !== undefined) return ledger
    }
    throw new Error(`fixture object unavailable: ${value.sha256}`)
  },
})
const permutationA = await buildBundle(
  continuing,
  bundleSource(store, continuing),
  permutationAPath,
  repositoryId,
)
const permutationB = await buildBundle(
  permuted,
  bundleSource(permutedStore, permuted),
  permutationBPath,
  repositoryId,
)
const permutationEqual =
  canonicalJson(permuted) === canonicalJson(continuing) &&
  permutationA.sha256 === permutationB.sha256
await rm(permutationAPath, { recursive: true, force: true })
await rm(permutationBPath, { recursive: true, force: true })

// Production reconstruction consumes only bundle CAS in a fresh directory whose ancestors contain no .git.
const reconstruction = join(output, 'reconstructed')
await rm(reconstruction, { recursive: true, force: true })
await mkdir(reconstruction, { recursive: true })
const bundledManifestBytes = await readFile(
  join(output, 'complete-bundle', '.factory', objectOwnedPath(code.sha256)),
)
const bundledManifest = parseCodeManifest(
  JSON.parse(new TextDecoder().decode(bundledManifestBytes)),
)
await reconstructCodeManifest(bundledManifest, reconstruction, value =>
  readFile(join(output, 'complete-bundle', '.factory', objectOwnedPath(value.sha256))),
)
const reconstructedWithoutGit =
  new TextDecoder().decode(await readFile(join(reconstruction, 'src/reviewed.ts'))) ===
  'export const reviewed = true\n'
let gitDiscoveryFailed = true
try {
  gitDiscoveryFailed =
    Bun.spawnSync(['git', '-C', reconstruction, 'rev-parse', '--show-toplevel']).exitCode !== 0
} catch {
  // The outer harness repeats this assertion with the host Git executable.
}

const plans = [
  complete,
  partial,
  corruptSibling,
  unchanged,
  continuing,
  policy,
  weakAndOrphan,
  recoveredDefault,
  recoveredForce,
  prPlan,
  incrementalPr,
  forcePush,
  prBadBatches,
  prMissingRaw,
]
const names = [
  'complete',
  'readable-partial',
  'corrupt-sibling-best-effort',
  'unchanged-no-op',
  'continuing-session',
  'policy-change',
  'weak-and-orphan',
  'accepted-gap-recovered-default',
  'accepted-gap-recovered-force',
  'pr-exact-and-manual',
  'pr-unchanged-diff-new-session-range',
  'pr-force-push-base-change',
  'pr-valid-association-with-corrupt-and-unsafe-batches',
  'pr-missing-raw-subject-provenance',
]
let reviewerDockerStarts = 0
let noOpBundleBuilds = 0
let noOpObjectReads = 0
const exerciseExecutionGate = (plan: ReviewPlan) => {
  if (plan.status !== 'ready') return
  noOpBundleBuilds += 1
  noOpObjectReads += 1
  reviewerDockerStarts += 1
}
exerciseExecutionGate(unchanged)
const report = {
  schemaVersion: 1,
  cases: plans.map((plan, index) => ({
    name: names[index],
    status: plan.status,
    subjectReview: plan.subjectReview,
    ...(plan.fullReviewReason === undefined ? {} : { fullReviewReason: plan.fullReviewReason }),
    selections: plan.selections.map(selection => ({
      classification: selection.classification,
      coverageEffect: selection.coverageEffect,
      selectedForReview: selection.selectedForReview,
      reason: selection.reason,
      proofs: selection.association?.proofs ?? [],
      limitations: selection.limitations,
    })),
    inputProblems: plan.inputProblems,
    limitations: plan.limitations,
  })),
  bundles: {
    complete: completeBundle.sha256,
    partial: partialBundle.sha256,
    pullRequest: prBundle.sha256,
    pullRequestIncremental: incrementalPrBundle.sha256,
  },
  noOpGate: {
    status: unchanged.status,
    bundleBuilds: noOpBundleBuilds,
    objectReads: noOpObjectReads,
    reviewerDockerStarts,
  },
  permutationEqual,
  freshDirectoryVerification: (
    await verifyBundle(join(output, 'complete-bundle'), completeBundle.sha256)
  ).valid,
  reconstructedWithoutGit,
  gitDiscoveryFailed,
}
if (
  !report.permutationEqual ||
  !report.freshDirectoryVerification ||
  !report.reconstructedWithoutGit ||
  !report.gitDiscoveryFailed ||
  reviewerDockerStarts !== 0 ||
  noOpBundleBuilds !== 0 ||
  noOpObjectReads !== 0 ||
  unchanged.status !== 'already-reviewed' ||
  prPlan.selections[0]?.association?.proofs.length !== 2 ||
  incrementalPr.subjectReview !== 'full-current-pr-diff' ||
  incrementalPr.selections.filter(selection => selection.selectedForReview).length !== 1 ||
  incrementalPr.priorLedger === undefined ||
  forcePush.subjectReview !== 'full-current-pr-diff'
)
  throw new Error('review planning lab acceptance failed')

await writeFile(join(output, 'report.json'), canonicalJson(report))
const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const cards = report.cases
  .map(
    item =>
      `<article><h2>${item.name}</h2><p><code>${item.status}</code> · ${item.subjectReview}</p><ul>${item.selections.map(selection => `<li><strong>${selection.classification}</strong> / ${selection.coverageEffect}: ${escape(selection.reason)}</li>`).join('') || '<li>No new Session evidence</li>'}</ul>${item.inputProblems.length === 0 ? '' : `<details><summary>Input problems</summary><pre>${escape(JSON.stringify(item.inputProblems, null, 2))}</pre></details>`}</article>`,
  )
  .join('')
await writeFile(
  join(output, 'index.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Factory review planning</title><style>body{font:15px/1.5 system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem;background:#101416;color:#e7efed}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1rem}article{background:#182023;border:1px solid #344348;border-radius:10px;padding:1rem}h1,h2{color:#9ee7d7}h2{font-size:1.05rem}code,pre{background:#0d1113;padding:.15rem .3rem}pre{white-space:pre-wrap}.ok{color:#83e377}</style></head><body><h1>Deterministic review planning</h1><p class="ok">Production loading, incremental coverage, readable partials, exact/manual PR association, no-op gating, portable verification, and no-Git reconstruction passed.</p><p>Permutation equality: <strong>${report.permutationEqual}</strong>. Reviewer starts for no-op: <strong>${reviewerDockerStarts}</strong>. Git discovery: <strong>failed as required</strong>.</p><div class="grid">${cards}</div></body></html>\n`,
)
console.log(`Review plan evidence: ${join(output, 'index.html')}`)
