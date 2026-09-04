import { describe, expect, test } from 'bun:test'

import {
  githubRepositoryKey as makeGithubRepositoryKey,
  type GithubRepositoryKey,
  type GithubRepositoryMappingObservation,
  type RecordId,
  type RepositoryId,
  type Sha256,
} from '../../contract/src/index'
import { deriveAssociations, explainAssociations, type SessionCodeEvidence } from '../src/index'

const sha = (digit: string) => digit.repeat(40)
const id = (prefix: string, digit = '0') => `${prefix}_${digit.repeat(26)}` as RecordId
const repositoryKey = (value: string) => makeGithubRepositoryKey('github.com', `R_${value}`)
const repositoryId = (value: string) => `repo_${value}` as RepositoryId
const mapping = (
  local: RepositoryId,
  key: GithubRepositoryKey,
  digit: string,
  providerId: string,
): GithubRepositoryMappingObservation => ({
  schemaVersion: 1,
  observationId: id('github-repository-mapping', digit),
  provider: 'github',
  repositoryId: local,
  repositoryKey: key,
  externalId: providerId,
  hostname: 'github.com',
  repository: key === repositoryKey('base') ? 'owner/repo' : 'contributor/repo',
  url:
    key === repositoryKey('base')
      ? 'https://github.com/owner/repo'
      : 'https://github.com/contributor/repo',
  observedAt: '2026-09-05T00:00:00Z',
  raw: [
    {
      algorithm: 'sha256',
      sha256: digit.repeat(64),
      bytes: 1,
      mediaType: 'application/json',
      role: 'github-repository-metadata',
    },
  ],
})
const baseRepositoryId = repositoryId('base')
const forkRepositoryId = repositoryId('fork')
const mappings = [
  mapping(baseRepositoryId, repositoryKey('base'), '4', 'R_base'),
  mapping(forkRepositoryId, repositoryKey('fork'), '5', 'R_fork'),
]
const session = (
  sessionKey: string,
  localRepositoryId: RepositoryId,
  observationId: RecordId,
  head?: string,
): SessionCodeEvidence => ({
  provider: 'codex',
  turn: {
    schemaVersion: 1,
    turnId: id('turn', observationId.at(-1) ?? '0'),
    sessionKey,
    nativeStopId: `stop-${sessionKey}`,
    capturedAt: '2026-09-05T00:00:00Z',
    materializedAt: '2026-09-05T00:00:00Z',
    eventRange: { first: 0, last: 0 },
    transcriptObservations: [],
    rawObjects: [],
    repositoryObservationId: observationId,
    limitations: [],
    captureAdapterVersion: 'fixture',
    formatVersion: 1,
    inventory: [],
  },
  repositoryObservation: {
    schemaVersion: 1,
    observationId,
    repositoryId: localRepositoryId,
    observedAt: '2026-09-05T00:00:00Z',
    completedAt: '2026-09-05T00:00:00Z',
    git: { ...(head === undefined ? {} : { head }), detached: false },
    changedPaths: [],
    worktreeFingerprint: '0'.repeat(64) as Sha256,
    limitations: [],
    startState: '1'.repeat(64) as Sha256,
    endState: '1'.repeat(64) as Sha256,
  },
})
const observation = {
  schemaVersion: 1 as const,
  observationId: id('pr-observation'),
  provider: 'github' as const,
  repositoryKey: repositoryKey('base'),
  number: 42,
  availability: 'available' as const,
  completeness: 'complete' as const,
  commitMembership: 'complete' as const,
  state: 'open' as const,
  externalId: 'PR_42',
  hostname: 'github.com',
  url: 'https://github.com/owner/repo/pull/42',
  base: {
    repositoryKey: repositoryKey('base'),
    externalId: 'R_base',
    repository: 'owner/repo',
    ref: 'main',
    sha: sha('1'),
  },
  head: {
    repositoryKey: repositoryKey('fork'),
    externalId: 'R_fork',
    repository: 'contributor/repo',
    ref: 'feature',
    sha: sha('3'),
  },
  commits: [sha('2'), sha('3')] as [string, ...string[]],
  observedAt: '2026-09-05T01:00:00Z',
  providerUpdatedAt: '2026-09-05T00:00:00Z',
  raw: [
    {
      algorithm: 'sha256' as const,
      sha256: 'a'.repeat(64),
      bytes: 1,
      mediaType: 'application/json',
      role: 'github-pr-metadata',
    },
  ],
  diff: {
    algorithm: 'sha256' as const,
    sha256: 'b'.repeat(64),
    bytes: 1,
    mediaType: 'text/x-diff',
    role: 'pull-request-diff',
  },
  limitations: [
    {
      code: 'unavailable-pull-request-code' as const,
      detail: 'Fixture has no code manifest',
    },
  ],
}

describe('direct Session-to-PR association fold', () => {
  test('uses only exact Git identity across the base and fork repositories', () => {
    const records = deriveAssociations({
      pullRequest: observation,
      sessions: [
        session('base', baseRepositoryId, id('observation', '1'), sha('2')),
        session('fork', forkRepositoryId, id('observation', '2'), sha('3')),
        session('weak-context-only', baseRepositoryId, id('observation', '3'), sha('9')),
      ],
      repositoryMappings: mappings,
    })
    expect(
      records.map(record => [record.sessionKey, record.kind, record.repositoryIdentity]),
    ).toEqual([
      ['base', 'commit', 'same'],
      ['fork', 'head', 'different'],
    ])
    expect(
      explainAssociations({
        pullRequest: observation,
        sessions: [session('weak-context-only', baseRepositoryId, id('observation'), sha('9'))],
        repositoryMappings: mappings,
      })[0],
    ).toEqual({
      sessionKey: 'weak-context-only',
      accepted: false,
      reason: 'git-object-not-in-pr',
    })
  })

  test('adds manual and invalidation facts without mutating old proof', () => {
    const previous = deriveAssociations({
      pullRequest: observation,
      sessions: [session('base', baseRepositoryId, id('observation'), sha('2'))],
      repositoryMappings: mappings,
    })[0]!
    const moved = {
      ...observation,
      observationId: id('pr-observation', '1'),
      head: { ...observation.head, sha: sha('4') },
      commits: [sha('4')] as [string, ...string[]],
    }
    const records = deriveAssociations({
      pullRequest: moved,
      sessions: [],
      repositoryMappings: mappings,
      previous: [previous],
      manual: [
        {
          sessionKey: 'manual',
          actor: 'developer',
          reason: 'confirmed contribution',
          observedAt: '2026-09-05T02:00:00Z',
        },
      ],
    })
    expect(records.find(record => record.kind === 'invalidation')?.invalidates).toBe(
      previous.evidenceId,
    )
    expect(records.find(record => record.kind === 'manual')?.strength).toBe('asserted')
    expect(previous.kind).toBe('commit')
  })

  test('is deterministic under input permutation and duplicate evidence', () => {
    const sessions = [
      session('base', baseRepositoryId, id('observation', '1'), sha('2')),
      session('fork', forkRepositoryId, id('observation', '2'), sha('3')),
    ]
    const forward = deriveAssociations({
      pullRequest: observation,
      sessions,
      repositoryMappings: mappings,
    })
    const reversed = deriveAssociations({
      pullRequest: observation,
      sessions: [...sessions].reverse(),
      repositoryMappings: [...mappings].reverse(),
    })
    const duplicated = deriveAssociations({
      pullRequest: observation,
      sessions: [...sessions, sessions[0]!],
      repositoryMappings: mappings,
    })
    expect(reversed).toEqual(forward)
    expect(duplicated).toEqual(forward)
  })

  test('keeps exact SHA evidence when repository classification is unavailable', () => {
    const records = deriveAssociations({
      pullRequest: observation,
      sessions: [
        session('portable', repositoryId('portable'), id('observation', '7'), observation.head.sha),
      ],
      repositoryMappings: [],
    })
    expect(records[0]?.repositoryIdentity).toBe('unavailable')
    expect(records[0]?.sourceObservationIds).toEqual([id('turn', '7'), id('observation', '7')])
  })

  test('allows exact head only for partial commit membership and never invalidates by absence', () => {
    const partial = {
      ...observation,
      completeness: 'partial' as const,
      commitMembership: 'prefix' as const,
      commits: [sha('2')],
      limitations: [
        ...observation.limitations,
        {
          code: 'incomplete-pull-request-commits' as const,
          detail: 'bounded prefix',
        },
      ],
    }
    const prior = deriveAssociations({
      pullRequest: observation,
      sessions: [session('base', baseRepositoryId, id('observation', '6'), sha('2'))],
      repositoryMappings: mappings,
    })[0]!
    const records = deriveAssociations({
      pullRequest: partial,
      sessions: [
        session('head', forkRepositoryId, id('observation', '7'), sha('3')),
        session('prefix-is-not-membership', baseRepositoryId, id('observation', '6'), sha('2')),
      ],
      repositoryMappings: mappings,
      previous: [prior],
    })
    expect(records.map(record => record.sessionKey)).toEqual(['head'])
  })

  test('retains old head after a normal push and invalidates it after force-push removal', () => {
    const prior = deriveAssociations({
      pullRequest: observation,
      sessions: [session('fork', forkRepositoryId, id('observation', '2'), sha('3'))],
      repositoryMappings: mappings,
    })[0]!
    const normalPush = {
      ...observation,
      observationId: id('pr-observation', '6'),
      head: { ...observation.head, sha: sha('4') },
      commits: [sha('2'), sha('3'), sha('4')] as [string, ...string[]],
    }
    expect(
      deriveAssociations({
        pullRequest: normalPush,
        sessions: [],
        repositoryMappings: mappings,
        previous: [prior],
      }),
    ).toEqual([])
    const forcePush = {
      ...normalPush,
      commits: [sha('4')] as [string, ...string[]],
    }
    expect(
      deriveAssociations({
        pullRequest: forcePush,
        sessions: [],
        repositoryMappings: mappings,
        previous: [prior],
      })[0]?.kind,
    ).toBe('invalidation')
  })
})
