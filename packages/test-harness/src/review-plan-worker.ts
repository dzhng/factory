import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  canonicalJson,
  decodeGitPath,
  encodeGitPath,
  githubRepositoryKey,
  newRecordId,
  objectOwnedPath,
  parseCodeManifest,
  type ObjectRef,
  type AssociationBatch,
  type AvailablePullRequestObservation,
  type RepositoryObservation,
  type ReviewTrigger,
  type SessionIdentity,
  type TurnManifest,
} from '@factory/contract'
import { deriveAssociations } from '@factory/domain'
import {
  buildBundle,
  planReviewForTesting as planReview,
  verifyBundle,
  type ReviewInputs,
} from '@factory/review-plan/testing'

const output = process.env.FACTORY_REVIEW_PLAN_OUTPUT ?? '/output'
await mkdir(output, { recursive: true })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const object = (bytes: Uint8Array, mediaType: string, role: string): ObjectRef => ({
  algorithm: 'sha256',
  sha256: hash(bytes),
  bytes: bytes.byteLength,
  mediaType,
  role,
})
const at = '2026-09-05T00:00:00Z'
const fileBytes = new TextEncoder().encode('export const reviewed = true\n')
const file = object(fileBytes, 'application/octet-stream', 'workspace-file')
const codeBytes = new TextEncoder().encode(
  canonicalJson({
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
  }),
)
const code = object(
  codeBytes,
  'application/vnd.factory.code-manifest+json',
  'workspace-code-manifest',
)
const rawBytes = new TextEncoder().encode('{"provider":"codex"}\n')
const raw = object(rawBytes, 'application/json', 'provider-event')
const objects = new Map([
  [file.sha256, fileBytes],
  [code.sha256, codeBytes],
  [raw.sha256, rawBytes],
])
const id = (kind: string, n: number) => {
  const entropy = new Uint8Array(10)
  entropy[9] = n
  return newRecordId(kind, n, entropy)
}
const identity: SessionIdentity = {
  schemaVersion: 1,
  provider: 'codex',
  nativeSessionId: 'native-review-lab',
  sessionKey: 'session-review-lab',
  captureGeneration: 0,
  repositoryId: 'repo_review_lab',
  firstObservedAt: at,
}
const observation = (n: number): RepositoryObservation => ({
  schemaVersion: 1,
  observationId: id('observation', n),
  repositoryId: 'repo_review_lab',
  observedAt: at,
  completedAt: at,
  git: { head: String(n).repeat(40), branch: 'feature/review', detached: false },
  changedPaths: [],
  worktreeFingerprint: code.sha256,
  codeManifest: code,
  limitations: [],
  startState: 'a'.repeat(64),
  endState: 'a'.repeat(64),
})
const candidate = (n: number, partial = false) => {
  const repo = observation(n)
  const turn: TurnManifest = {
    schemaVersion: 1,
    turnId: id('turn', n),
    sessionKey: identity.sessionKey,
    nativeStopId: `stop-${n}`,
    capturedAt: at,
    materializedAt: at,
    eventRange: { first: n, last: n },
    transcriptObservations: [],
    rawObjects: [raw],
    repositoryObservationId: repo.observationId,
    codeManifest: code,
    limitations: partial
      ? [{ code: 'missing-transcript-range', detail: 'readable prefix only' }]
      : [],
    captureAdapterVersion: 'lab',
    formatVersion: 1,
    inventory: [code, raw, file].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
  }
  const trigger: ReviewTrigger = {
    schemaVersion: 1,
    triggerId: id('trigger', n),
    sessionKey: identity.sessionKey,
    turnId: turn.turnId,
    repositoryObservationId: repo.observationId,
    evidenceWatermark: n,
    provider: 'codex',
    createdAt: at,
    materialization: partial ? 'partial' : 'complete',
    limitations: turn.limitations,
  }
  return {
    identity,
    trigger,
    turn,
    repositoryObservation: repo,
    events: [{ sequence: n, observedAt: at, raw }],
    transcript: [],
  }
}
const base = (candidates = [candidate(1)]): ReviewInputs => ({
  mode: 'incremental',
  subject: { kind: 'workspace', observation: observation(1) },
  candidates,
  reviews: [],
  coverageActions: [],
  associations: [],
  policies: {
    reviewer: { provider: 'codex' },
    analyzerVersion: 'analyzer-v1',
    promptVersion: 'prompt-v1',
    policyVersion: 'policy-v1',
    formatVersion: 1,
  },
})
const complete = planReview(base())
const partial = planReview(base([candidate(1, true)]))
const completeBundle = await buildBundle(
  complete,
  { getObject: async ref => objects.get(ref.sha256)! },
  join(output, 'complete-bundle'),
)
const partialBundle = await buildBundle(
  partial,
  { getObject: async ref => objects.get(ref.sha256)! },
  join(output, 'partial-bundle'),
)
const prDiffBytes = new TextEncoder().encode('diff --git a/src/reviewed.ts b/src/reviewed.ts\n')
const prDiff = object(prDiffBytes, 'text/x-diff', 'pull-request-diff')
const prRawBytes = new TextEncoder().encode('{"number":42}\n')
const prRaw = object(prRawBytes, 'application/json', 'github-pr-metadata')
objects.set(prDiff.sha256, prDiffBytes)
objects.set(prRaw.sha256, prRawBytes)
const repositoryKey = githubRepositoryKey('github.com', 'R_review_lab')
const prCandidate = candidate(1)
const prObservation: AvailablePullRequestObservation = {
  schemaVersion: 1,
  observationId: id('pr-observation', 1),
  provider: 'github',
  repositoryKey,
  number: 42,
  availability: 'available',
  completeness: 'partial',
  commitMembership: 'prefix',
  codeAvailability: 'unavailable',
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
    sha: '1'.repeat(40),
  },
  commits: [],
  raw: [prRaw],
  diff: prDiff,
  limitations: [
    { code: 'incomplete-pull-request-commits', detail: 'membership prefix unavailable' },
    { code: 'unavailable-pull-request-code', detail: 'full diff remains readable' },
  ],
}
const associations = deriveAssociations({
  pullRequest: prObservation,
  sessions: [
    {
      provider: 'codex',
      turn: prCandidate.turn,
      repositoryObservation: prCandidate.repositoryObservation,
    },
  ],
  repositoryMappings: [],
})
const batch: AssociationBatch = {
  schemaVersion: 1,
  batchId: id('association-batch', 1),
  provider: 'github',
  repositoryKey,
  number: 42,
  pullRequestObservationId: prObservation.observationId,
  kind: 'automatic',
  evidence: associations
    .map(evidence => ({
      evidenceId: evidence.evidenceId,
      sha256: hash(new TextEncoder().encode(canonicalJson(evidence))),
    }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
  sourceObservationIds: [
    ...new Set(associations.flatMap(evidence => evidence.sourceObservationIds)),
  ].sort(),
  observedAt: at,
  policyVersion: 'factory-v1-exact-git-v1',
}
const prPlan = planReview({
  ...base([prCandidate]),
  subject: { kind: 'pull-request', observation: prObservation },
  associations: [{ batch, evidence: associations }],
})
const prBundle = await buildBundle(
  prPlan,
  { getObject: async ref => objects.get(ref.sha256)! },
  join(output, 'pr-bundle'),
)
const prior = {
  reviewId: id('review', 1),
  subject: complete.subject,
  subjectFingerprint: complete.subjectFingerprint,
  subjectAttempt: {
    fingerprint: complete.subjectFingerprint,
    coverageId: complete.subjectAttempt.coverageId,
    effect: 'settled' as const,
    limitations: [],
  },
  sessionWatermarks: complete.sessionWatermarks,
  coverageTargetWatermarks: complete.coverageTargetWatermarks,
  selections: complete.selections,
  triggerIds: complete.triggerIds,
  disposition: 'complete' as const,
  policies: complete.policies,
}
const unchanged = planReview({ ...base(), reviews: [prior] })
const continuing = planReview({
  ...base([candidate(1), candidate(2)]),
  subject: { kind: 'workspace', observation: observation(2) },
  reviews: [prior],
})
const force = planReview({ ...base(), mode: 'force', reviews: [prior] })
const policy = planReview({
  ...base(),
  policies: { ...base().policies, policyVersion: 'policy-v2' },
  reviews: [prior],
})
const corrupt = planReview({
  ...base(),
  candidates: [
    {
      kind: 'range',
      sessionKey: identity.sessionKey,
      triggerId: id('trigger', 1),
      turnId: id('turn', 1),
      evidenceWatermark: 1,
      scopeProof: { kind: 'workspace-store', repositoryId: 'repo_lab' },
      availability: 'corrupt',
      limitations: [{ code: 'corrupt-input', detail: 'fixture corruption' }],
    },
  ],
})
const permutationEqual =
  canonicalJson(planReview(base([candidate(1), candidate(2)]))) ===
  canonicalJson(planReview(base([candidate(2), candidate(1)])))
const reconstructedRoot = '/tmp/factory-review-plan-reconstructed'
await mkdir(join(reconstructedRoot, 'src'), { recursive: true })
const bundledCodeBytes = await readFile(
  join(output, 'complete-bundle', '.factory', objectOwnedPath(code.sha256)),
)
const bundledCode = parseCodeManifest(JSON.parse(new TextDecoder().decode(bundledCodeBytes)))
const bundledEntry = bundledCode.entries[0]!
if (bundledEntry.kind === 'gitlink') throw new Error('fixture unexpectedly contains a gitlink')
const reconstructedPath = new TextDecoder().decode(decodeGitPath(bundledEntry.path))
const bundledFileBytes = await readFile(
  join(output, 'complete-bundle', '.factory', objectOwnedPath(bundledEntry.object.sha256)),
)
await writeFile(join(reconstructedRoot, reconstructedPath), bundledFileBytes)
const reconstructedWithoutGit =
  new TextDecoder().decode(await readFile(join(reconstructedRoot, reconstructedPath))) ===
  'export const reviewed = true\n'
const report = {
  schemaVersion: 1,
  cases: [
    {
      name: 'complete',
      status: complete.status,
      reasons: complete.selections.map(item => item.reason),
      digest: completeBundle.sha256,
    },
    {
      name: 'readable-partial',
      status: partial.status,
      reasons: partial.selections.map(item => item.reason),
      digest: partialBundle.sha256,
    },
    {
      name: 'corrupt',
      status: corrupt.status,
      reasons: corrupt.selections.map(item => item.reason),
    },
    {
      name: 'unchanged',
      status: unchanged.status,
      reasons: unchanged.selections.map(item => item.reason),
    },
    {
      name: 'continuing-session',
      status: continuing.status,
      reasons: continuing.selections.map(item => item.reason),
    },
    { name: 'force', status: force.status, reasons: force.selections.map(item => item.reason) },
    {
      name: 'policy-change',
      status: policy.status,
      reasons: policy.selections.map(item => item.reason),
    },
    {
      name: 'partial-pr-exact-head',
      status: prPlan.status,
      reasons: prPlan.selections.map(item => item.reason),
      digest: prBundle.sha256,
    },
  ],
  permutationEqual,
  freshDirectoryVerification: (
    await verifyBundle(join(output, 'complete-bundle'), completeBundle.sha256)
  ).valid,
  reconstructedWithoutGit,
}
await writeFile(join(output, 'report.json'), canonicalJson(report))
await writeFile(
  join(output, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Factory review planning</title><style>body{font:16px system-ui;max-width:72rem;margin:2rem auto}code{background:#eee;padding:.15rem .3rem}li{margin:.7rem 0}</style><h1>Review planning and bundle evidence</h1><p>Both complete and readable-partial inputs produced self-contained bundles. Corrupt evidence stayed classified while readable siblings remained eligible.</p><ul>${report.cases.map(item => `<li><strong>${item.name}</strong>: <code>${item.status}</code> — ${item.reasons.join(', ') || 'no new evidence'}</li>`).join('')}</ul><p>Permutation equality: <strong>${permutationEqual}</strong>. Fresh-directory verification: <strong>${report.freshDirectoryVerification}</strong>.</p>`,
)
console.log(`Review plan evidence: ${join(output, 'index.html')}`)
