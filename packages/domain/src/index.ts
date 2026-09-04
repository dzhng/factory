import { createHash } from 'node:crypto'

import {
  canonicalJson,
  makeOwnedPath,
  newRecordId,
  validatePublicRecord,
  type AvailablePullRequestObservation,
  type GithubRepositoryMappingObservation,
  type RecordId,
  type RepositoryObservation,
  type SessionPullRequestAssociation,
  type TurnManifest,
} from '@factory/contract'

export type SessionCodeEvidence = {
  provider: 'codex' | 'claude'
  turn: TurnManifest
  repositoryObservation: RepositoryObservation
}
export type ManualAssociation = {
  sessionKey: string
  actor: string
  reason: string
  observedAt: string
}
export type AssociationInputs = {
  pullRequest: AvailablePullRequestObservation
  sessions: readonly SessionCodeEvidence[]
  repositoryMappings: readonly GithubRepositoryMappingObservation[]
  manual?: readonly ManualAssociation[]
  previous?: readonly SessionPullRequestAssociation[]
}
export type AssociationExplanation = {
  sessionKey: string
  accepted: boolean
  kind?: 'commit' | 'head'
  reason:
    | 'exact-pr-head'
    | 'exact-pr-commit'
    | 'git-head-unavailable'
    | 'unstable-repository-observation'
    | 'commit-set-incomplete'
    | 'git-object-not-in-pr'
}

function validatePullRequest(pullRequest: AvailablePullRequestObservation): void {
  validatePublicRecord(
    makeOwnedPath('pull-requests', [
      'github',
      pullRequest.repositoryKey,
      String(pullRequest.number),
      'observations',
      `${pullRequest.observationId}.json`,
    ]),
    pullRequest,
  )
}
function validateMapping(mapping: GithubRepositoryMappingObservation): void {
  validatePublicRecord(
    makeOwnedPath('pull-requests', [
      'github',
      mapping.repositoryKey,
      'repository-mappings',
      mapping.repositoryId,
      `${mapping.observationId}.json`,
    ]),
    mapping,
  )
}
function validateSession(session: SessionCodeEvidence): void {
  validatePublicRecord(
    makeOwnedPath('sessions', [
      session.provider,
      session.turn.sessionKey,
      'turns',
      session.turn.turnId,
      'manifest.json',
    ]),
    session.turn,
  )
  validatePublicRecord(
    makeOwnedPath('repository-observations', [
      `${session.repositoryObservation.observationId}.json`,
    ]),
    session.repositoryObservation,
  )
  if (session.turn.repositoryObservationId !== session.repositoryObservation.observationId) {
    throw new TypeError('turn does not reference its repository observation')
  }
}
function matchingMapping(
  input: Pick<AssociationInputs, 'pullRequest' | 'repositoryMappings'>,
  session: SessionCodeEvidence,
): GithubRepositoryMappingObservation | undefined {
  const candidates = input.repositoryMappings.filter(
    mapping => mapping.repositoryId === session.repositoryObservation.repositoryId,
  )
  const identities = new Set(candidates.map(mapping => mapping.repositoryKey))
  if (identities.size !== 1) return undefined
  const identity = [...identities][0]!
  if (
    identity !== input.pullRequest.repositoryKey &&
    identity !== input.pullRequest.head.repositoryKey
  ) {
    return undefined
  }
  return [...candidates].sort((left, right) =>
    left.observationId.localeCompare(right.observationId),
  )[0]
}

/** Explain the exact Git-evidence gate used by derivation, including every rejection. */
export function explainAssociations(
  input: Pick<AssociationInputs, 'pullRequest' | 'sessions' | 'repositoryMappings'>,
): readonly AssociationExplanation[] {
  validatePullRequest(input.pullRequest)
  input.repositoryMappings.forEach(validateMapping)
  input.sessions.forEach(validateSession)
  const commits = new Set(input.pullRequest.commits)
  return input.sessions.map(session => {
    const sessionKey = session.turn.sessionKey
    if (
      session.repositoryObservation.startState !== session.repositoryObservation.endState ||
      session.repositoryObservation.limitations.some(item => item.code === 'repository-race')
    ) {
      return { sessionKey, accepted: false, reason: 'unstable-repository-observation' }
    }
    const head = session.repositoryObservation.git.head
    if (head === undefined) return { sessionKey, accepted: false, reason: 'git-head-unavailable' }
    if (input.pullRequest.head.sha !== undefined && head === input.pullRequest.head.sha) {
      return { sessionKey, accepted: true, kind: 'head', reason: 'exact-pr-head' }
    }
    if (input.pullRequest.commitMembership !== 'complete') {
      return { sessionKey, accepted: false, reason: 'commit-set-incomplete' }
    }
    if (commits.has(head)) {
      return { sessionKey, accepted: true, kind: 'commit', reason: 'exact-pr-commit' }
    }
    return { sessionKey, accepted: false, reason: 'git-object-not-in-pr' }
  })
}

function associationId(value: unknown, observedAt: string): RecordId {
  const digest = createHash('sha256').update(canonicalJson(value)).digest()
  return newRecordId('association', Date.parse(observedAt), digest.subarray(0, 10))
}

/** Derive append-only direct evidence; mappings classify identity but never unlock a SHA match. */
export function deriveAssociations(
  input: AssociationInputs,
): readonly SessionPullRequestAssociation[] {
  const records: SessionPullRequestAssociation[] = []
  const explanations = explainAssociations(input)
  const commits = new Set(input.pullRequest.commits)
  for (const [index, session] of input.sessions.entries()) {
    const explanation = explanations[index]!
    const head = session.repositoryObservation.git.head
    if (!explanation.accepted || explanation.kind === undefined || head === undefined) continue
    const mapping = matchingMapping(input, session)
    const repositoryIdentity =
      mapping?.repositoryKey === input.pullRequest.repositoryKey
        ? 'same'
        : mapping?.repositoryKey === input.pullRequest.head.repositoryKey
          ? 'different'
          : 'unavailable'
    const body = {
      sessionKey: session.turn.sessionKey,
      pullRequestObservationId: input.pullRequest.observationId,
      kind: explanation.kind,
      shas: [head] as [string],
      sourceObservationIds: [
        session.turn.turnId,
        session.repositoryObservation.observationId,
        ...(mapping === undefined ? [] : [mapping.observationId]),
      ] as [RecordId, ...RecordId[]],
    }
    records.push({
      schemaVersion: 1,
      evidenceId: associationId(body, input.pullRequest.observedAt),
      ...body,
      strength: 'verified',
      repositoryIdentity,
      observedAt: input.pullRequest.observedAt,
    })
  }
  for (const manual of input.manual ?? []) {
    const body = {
      sessionKey: manual.sessionKey,
      pullRequestObservationId: input.pullRequest.observationId,
      kind: 'manual' as const,
      assertion: { actor: manual.actor, reason: manual.reason },
    }
    records.push({
      schemaVersion: 1,
      evidenceId: associationId(body, manual.observedAt),
      ...body,
      strength: 'asserted',
      shas: [] as const,
      repositoryIdentity: 'unavailable',
      sourceObservationIds: [] as const,
      observedAt: manual.observedAt,
    })
  }
  for (const previous of input.previous ?? []) {
    if (!['commit', 'head', 'code-state-continuity'].includes(previous.kind)) continue
    if (input.pullRequest.commitMembership !== 'complete') continue
    const absent = [...new Set(previous.shas.filter(sha => !commits.has(sha)))].sort()
    if (absent.length === 0) continue
    const body = {
      sessionKey: previous.sessionKey,
      pullRequestObservationId: input.pullRequest.observationId,
      kind: 'invalidation' as const,
      invalidates: previous.evidenceId,
      shas: absent as [string, ...string[]],
    }
    records.push({
      schemaVersion: 1,
      evidenceId: associationId(body, input.pullRequest.observedAt),
      ...body,
      strength: 'verified',
      repositoryIdentity: previous.repositoryIdentity,
      sourceObservationIds: [] as const,
      observedAt: input.pullRequest.observedAt,
    })
  }
  const result = [...new Map(records.map(record => [record.evidenceId, record])).values()].sort(
    (left, right) =>
      left.sessionKey.localeCompare(right.sessionKey) ||
      left.kind.localeCompare(right.kind) ||
      left.evidenceId.localeCompare(right.evidenceId),
  )
  for (const record of result) {
    validatePublicRecord(
      makeOwnedPath('pull-requests', [
        'github',
        input.pullRequest.repositoryKey,
        String(input.pullRequest.number),
        'associations',
        input.pullRequest.observationId,
        `${record.evidenceId}.json`,
      ]),
      record,
    )
  }
  return result
}
