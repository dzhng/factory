import { describe, expect, test } from 'bun:test'

import {
  canonicalJson,
  decodeGitPath,
  encodeGitPath,
  makeOwnedPath,
  newRecordId,
  parseRepositoryConfig,
  parseRepositoryManifest,
  UnsupportedRepositoryVersionError,
  validatePublicRecord,
} from '../src/index'

const recordId = (prefix: string, discriminator = '0') =>
  `${prefix}_${'0'.repeat(25)}${discriminator}`

describe('public repository contract', () => {
  test('encodes canonical JSON with sorted keys and a final newline', () => {
    expect(canonicalJson({ z: 1, nested: { b: true, a: 'first' }, a: [2, 1] })).toBe(
      '{"a":[2,1],"nested":{"a":"first","b":true},"z":1}\n',
    )
  })

  test('refuses cycles and non-JSON values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow('cyclic')
    expect(() => canonicalJson({ invalid: undefined })).toThrow('undefined')
  })

  test('constructs only declared owned paths', () => {
    expect(String(makeOwnedPath('sessions', ['codex', 'session_01', 'identity.json']))).toBe(
      'sessions/codex/session_01/identity.json',
    )
    expect(() => makeOwnedPath('sessions', ['..', 'skills', 'x'])).toThrow('safe path segment')
    expect(() => makeOwnedPath('sessions', ['codex/session'])).toThrow('safe path segment')
    expect(() => makeOwnedPath('skills' as never)).toThrow('does not own area')
  })

  test('creates sortable IDs and round-trips non-UTF-8 Git paths', () => {
    const earlier = newRecordId('turn', 1_000, new Uint8Array(10))
    const later = newRecordId('turn', 1_001, new Uint8Array(10))
    expect(earlier < later).toBe(true)
    expect(earlier).toMatch(/^turn_[0-9A-HJKMNP-TV-Z]{26}$/)

    const bytes = new Uint8Array([0x66, 0x6f, 0x80, 0xff])
    expect(decodeGitPath(encodeGitPath(bytes))).toEqual(bytes)
    expect(() =>
      validatePublicRecord(makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`]), {
        schemaVersion: 1,
        triggerId: 'trigger_01',
        sessionKey: 'session_01',
        turnId: recordId('turn'),
        evidenceWatermark: 0,
        provider: 'codex',
        createdAt: '2026-09-04T00:00:00Z',
        materialization: 'complete',
        limitations: [],
      }),
    ).toThrow('sortable Factory record ID')
  })

  test('stops at a too-new manifest before broader parsing', () => {
    expect(() =>
      parseRepositoryManifest({
        schemaVersion: 1,
        format: 'factory-repository',
        minimumReaderVersion: '9.0.0',
        repositoryId: 'repo_01JFACTORY0000000000000000',
        createdAt: '2026-09-04T00:00:00Z',
      }),
    ).toThrow(UnsupportedRepositoryVersionError)
    expect(() =>
      parseRepositoryManifest({ minimumReaderVersion: '9.0.0', futureShape: true }),
    ).toThrow(UnsupportedRepositoryVersionError)
  })

  test('accepts deferred reviewer selection and strict UTC manifest timestamps', () => {
    expect(
      parseRepositoryConfig({
        reviewer: { provider: 'claude', model: 'opus', futureOption: true },
        reviewLimits: { maxSessions: 2, futureLimit: 3 },
      }),
    ).toEqual({
      reviewer: { provider: 'claude', model: 'opus', futureOption: true },
      reviewLimits: { maxSessions: 2, futureLimit: 3 },
    })
    expect(parseRepositoryConfig({ reviewer: 'auto' })).toEqual({ reviewer: 'auto' })
    expect(() =>
      parseRepositoryManifest({
        schemaVersion: 1,
        format: 'factory-repository',
        minimumReaderVersion: '0.1.0',
        repositoryId: 'repo_01JFACTORY0000000000000000',
        createdAt: '2026-09-04 00:00:00',
      }),
    ).toThrow('UTC RFC 3339')
  })

  test('selects an exact schema for every public immutable record', () => {
    const timestamp = '2026-09-04T00:00:00Z'
    const hash = '0'.repeat(64)
    const object = {
      algorithm: 'sha256',
      sha256: hash,
      bytes: 0,
      mediaType: 'application/octet-stream',
      role: 'fixture',
    } as const
    const cases: Array<[ReturnType<typeof makeOwnedPath>, unknown]> = [
      [
        makeOwnedPath('sessions', ['codex', 'session_01', 'identity.json']),
        {
          schemaVersion: 1,
          provider: 'codex',
          nativeSessionId: 'native_01',
          sessionKey: 'session_01',
          captureGeneration: 1,
          repositoryId: 'repo_01',
          firstObservedAt: timestamp,
        },
      ],
      [
        makeOwnedPath('sessions', [
          'codex',
          'session_01',
          'lifecycle',
          `${recordId('event')}.json`,
        ]),
        {
          schemaVersion: 1,
          eventId: recordId('event'),
          sessionKey: 'session_01',
          providerEvent: 'SessionStart',
          observedAt: timestamp,
          raw: object,
        },
      ],
      [
        makeOwnedPath('sessions', [
          'codex',
          'session_01',
          'turns',
          recordId('turn'),
          'events.jsonl',
        ]),
        { sequence: 0, observedAt: timestamp, raw: object },
      ],
      [
        makeOwnedPath('sessions', [
          'codex',
          'session_01',
          'turns',
          recordId('turn'),
          'manifest.json',
        ]),
        {
          schemaVersion: 1,
          turnId: recordId('turn'),
          sessionKey: 'session_01',
          nativeStopId: 'stop_01',
          capturedAt: timestamp,
          materializedAt: timestamp,
          eventRange: { first: 0, last: 0 },
          transcriptObservations: [],
          rawObjects: [object],
          limitations: [],
          captureAdapterVersion: '0.1.0',
          formatVersion: 1,
          inventory: [object],
        },
      ],
      [
        makeOwnedPath('repository-observations', [`${recordId('observation')}.json`]),
        {
          schemaVersion: 1,
          observationId: recordId('observation'),
          repositoryId: 'repo_01',
          observedAt: timestamp,
          completedAt: timestamp,
          git: { detached: false },
          changedPaths: [],
          worktreeFingerprint: hash,
          limitations: [],
          startState: hash,
          endState: hash,
        },
      ],
      [
        makeOwnedPath('pull-requests', [
          'github',
          'owner-repo',
          '42',
          'observations',
          `${recordId('observation')}.json`,
        ]),
        {
          schemaVersion: 1,
          observationId: recordId('observation'),
          provider: 'github',
          repositoryKey: 'owner-repo',
          number: 42,
          state: 'open',
          commits: [],
          observedAt: timestamp,
          limitations: [],
        },
      ],
      [
        makeOwnedPath('pull-requests', [
          'github',
          'owner-repo',
          '42',
          'associations',
          recordId('observation'),
          `${recordId('evidence')}.json`,
        ]),
        {
          schemaVersion: 1,
          evidenceId: recordId('evidence'),
          sessionKey: 'session_01',
          pullRequestObservationId: recordId('observation'),
          kind: 'commit',
          strength: 'verified',
          shas: [hash],
          repositoryIdentity: 'same',
          sourceObservationIds: [recordId('observation')],
          observedAt: timestamp,
        },
      ],
      [
        makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`]),
        {
          schemaVersion: 1,
          triggerId: recordId('trigger'),
          sessionKey: 'session_01',
          turnId: recordId('turn'),
          evidenceWatermark: 1,
          provider: 'codex',
          createdAt: timestamp,
          materialization: 'complete',
          limitations: [],
        },
      ],
      [
        makeOwnedPath('reviews', ['workspace', recordId('review'), 'manifest.json']),
        {
          schemaVersion: 1,
          reviewId: recordId('review'),
          subject: { kind: 'workspace', repositoryObservationId: recordId('observation') },
          patches: [],
          sessionWatermarks: { session_01: 1 },
          triggerIds: [recordId('trigger')],
          limitations: [],
          reviewer: { provider: 'codex' },
          analyzerVersion: '0.1.0',
          promptVersion: '1',
          policyVersion: '1',
          formatVersion: 1,
          bundleSha256: hash,
          containerImageDigest: `sha256:${hash}`,
          providerCliVersion: '0.1.0',
          hostPlatform: 'linux/arm64',
          startedAt: timestamp,
          completedAt: timestamp,
          disposition: 'complete',
        },
      ],
      [
        makeOwnedPath('reviews', ['workspace', recordId('review'), 'ledger.json']),
        { schemaVersion: 1, reviewId: recordId('review'), entries: [] },
      ],
      [makeOwnedPath('reviews', ['workspace', recordId('review'), 'response.txt']), 'response\n'],
      [
        makeOwnedPath('reviews', ['coverage-actions', `${recordId('action')}.json`]),
        {
          schemaVersion: 1,
          actionId: recordId('action'),
          reviewId: recordId('review'),
          acceptedLimitations: [],
          settledWatermarks: {},
          createdAt: timestamp,
        },
      ],
      [
        makeOwnedPath('decisions', ['observations', `${recordId('decision')}.json`]),
        {
          schemaVersion: 1,
          observationId: recordId('decision'),
          reviewId: recordId('review'),
          reviewEntryId: recordId('entry'),
          subject: { path: 'src/index.ts' },
          summary: 'Fixture decision',
          canonicalBranch: true,
          confidence: 'high',
          observedAt: timestamp,
        },
      ],
      [
        makeOwnedPath('decisions', ['actions', `${recordId('action')}.json`]),
        {
          schemaVersion: 1,
          actionId: recordId('action'),
          kind: 'confirm',
          observationIds: [recordId('decision')],
          actor: { kind: 'human' },
          createdAt: timestamp,
        },
      ],
    ]

    for (const [path, value] of cases) expect(() => validatePublicRecord(path, value)).not.toThrow()
    expect(() =>
      validatePublicRecord(makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`]), {
        ...(cases[7]![1] as Record<string, unknown>),
        reviewed: true,
      }),
    ).toThrow('unknown fields')
  })

  test('rejects a malformed review trigger instead of accepting its top-level keys', () => {
    const trigger = {
      schemaVersion: 1,
      triggerId: recordId('trigger'),
      sessionKey: 'session_01',
      turnId: recordId('turn'),
      evidenceWatermark: 0,
      provider: 'codex',
      createdAt: '2026-09-04T00:00:00Z',
      materialization: 'complete',
      limitations: [],
    }
    expect(() =>
      validatePublicRecord(makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`]), {
        ...trigger,
        evidenceWatermark: -1,
      }),
    ).toThrow('evidenceWatermark')
    expect(() =>
      validatePublicRecord(makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`]), {
        ...trigger,
        materialization: 'mostly',
      }),
    ).toThrow('materialization')
    expect(() =>
      validatePublicRecord(makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`]), {
        ...trigger,
        limitations: ['not-a-limitation'],
      }),
    ).toThrow('limitations[0]')
  })

  test('rejects malformed decision actions and actions with no observations', () => {
    expect(() =>
      validatePublicRecord(makeOwnedPath('decisions', ['actions', `${recordId('action')}.json`]), {
        schemaVersion: 1,
        actionId: recordId('action'),
        kind: 'confirm',
        observationIds: [],
        actor: { kind: 'human' },
        createdAt: '2026-09-04T00:00:00Z',
      }),
    ).toThrow('observationIds')

    expect(() =>
      validatePublicRecord(makeOwnedPath('decisions', ['actions', `${recordId('action')}.json`]), {
        schemaVersion: 1,
        actionId: recordId('action'),
        kind: 'confirm',
        observationIds: [recordId('decision')],
        actor: { kind: 'review' },
        createdAt: '2026-09-04T00:00:00Z',
      }),
    ).toThrow('reviewId')
  })

  test('rejects malformed object references at their public-record boundary', () => {
    const path = makeOwnedPath('sessions', [
      'codex',
      'session_01',
      'lifecycle',
      `${recordId('event')}.json`,
    ])
    const raw = {
      algorithm: 'sha256',
      sha256: '0'.repeat(64),
      bytes: 0,
      mediaType: 'application/octet-stream',
      role: 'fixture',
    }
    const record = {
      schemaVersion: 1,
      eventId: recordId('event'),
      sessionKey: 'session_01',
      providerEvent: 'SessionStart',
      observedAt: '2026-09-04T00:00:00Z',
      raw,
    }
    expect(() =>
      validatePublicRecord(path, { ...record, raw: { ...raw, sha256: '0'.repeat(63) } }),
    ).toThrow('sha256')
    expect(() => validatePublicRecord(path, { ...record, raw: { ...raw, bytes: -1 } })).toThrow(
      'bytes',
    )
    expect(() => validatePublicRecord(path, { ...record, raw: { ...raw, mediaType: 7 } })).toThrow(
      'mediaType',
    )
  })

  test('binds a session identity provider and key to its owned path', () => {
    const identity = {
      schemaVersion: 1,
      provider: 'claude',
      nativeSessionId: 'native_01',
      sessionKey: 'session_other',
      captureGeneration: 1,
      repositoryId: 'repo_01',
      firstObservedAt: '2026-09-04T00:00:00Z',
    }
    expect(() =>
      validatePublicRecord(
        makeOwnedPath('sessions', ['codex', 'session_01', 'identity.json']),
        identity,
      ),
    ).toThrow('owned path')
  })

  test('binds payload identities to paths across repository, PR, review, and decision records', () => {
    const timestamp = '2026-09-04T00:00:00Z'
    const hash = '0'.repeat(64)
    const object = {
      algorithm: 'sha256',
      sha256: hash,
      bytes: 0,
      mediaType: 'application/octet-stream',
      role: 'fixture',
    }
    const mismatches: Array<[ReturnType<typeof makeOwnedPath>, unknown]> = [
      [
        makeOwnedPath('sessions', [
          'codex',
          'session_path',
          'lifecycle',
          `${recordId('event', '0')}.json`,
        ]),
        {
          schemaVersion: 1,
          eventId: recordId('event', '1'),
          sessionKey: 'session_payload',
          providerEvent: 'SessionStart',
          observedAt: timestamp,
          raw: object,
        },
      ],
      [
        makeOwnedPath('sessions', [
          'codex',
          'session_path',
          'turns',
          recordId('turn', '0'),
          'manifest.json',
        ]),
        {
          schemaVersion: 1,
          turnId: recordId('turn', '1'),
          sessionKey: 'session_payload',
          nativeStopId: 'stop_01',
          capturedAt: timestamp,
          materializedAt: timestamp,
          eventRange: { first: 0, last: 0 },
          transcriptObservations: [],
          rawObjects: [],
          limitations: [],
          captureAdapterVersion: '1',
          formatVersion: 1,
          inventory: [],
        },
      ],
      [
        makeOwnedPath('repository-observations', [`${recordId('observation', '0')}.json`]),
        {
          schemaVersion: 1,
          observationId: recordId('observation', '1'),
          repositoryId: 'repo_01',
          observedAt: timestamp,
          completedAt: timestamp,
          git: { detached: false },
          changedPaths: [],
          worktreeFingerprint: hash,
          limitations: [],
          startState: hash,
          endState: hash,
        },
      ],
      [
        makeOwnedPath('pull-requests', [
          'github',
          'owner-repo',
          '42',
          'observations',
          `${recordId('observation')}.json`,
        ]),
        {
          schemaVersion: 1,
          observationId: recordId('observation'),
          provider: 'github',
          repositoryKey: 'other-repo',
          number: 43,
          state: 'open',
          commits: [],
          observedAt: timestamp,
          limitations: [],
        },
      ],
      [
        makeOwnedPath('pull-requests', [
          'github',
          'owner-repo',
          '42',
          'associations',
          recordId('observation', '0'),
          `${recordId('evidence', '0')}.json`,
        ]),
        {
          schemaVersion: 1,
          evidenceId: recordId('evidence', '1'),
          sessionKey: 'session_01',
          pullRequestObservationId: recordId('observation', '1'),
          kind: 'commit',
          strength: 'verified',
          shas: [hash],
          repositoryIdentity: 'same',
          sourceObservationIds: [recordId('observation')],
          observedAt: timestamp,
        },
      ],
      [
        makeOwnedPath('review-triggers', [`${recordId('trigger', '0')}.json`]),
        {
          schemaVersion: 1,
          triggerId: recordId('trigger', '1'),
          sessionKey: 'session_01',
          turnId: recordId('turn'),
          evidenceWatermark: 0,
          provider: 'codex',
          createdAt: timestamp,
          materialization: 'complete',
          limitations: [],
        },
      ],
      [
        makeOwnedPath('reviews', [
          'pull-requests',
          'github',
          'owner-repo',
          '42',
          recordId('review', '0'),
          'manifest.json',
        ]),
        {
          schemaVersion: 1,
          reviewId: recordId('review', '1'),
          subject: {
            kind: 'pull-request',
            provider: 'github',
            repositoryKey: 'other-repo',
            number: 43,
            observationId: recordId('observation'),
          },
          patches: [],
          sessionWatermarks: {},
          triggerIds: [],
          limitations: [],
          reviewer: { provider: 'codex' },
          analyzerVersion: '1',
          promptVersion: '1',
          policyVersion: '1',
          formatVersion: 1,
          bundleSha256: hash,
          containerImageDigest: `sha256:${hash}`,
          providerCliVersion: '1',
          hostPlatform: 'linux/arm64',
          startedAt: timestamp,
          completedAt: timestamp,
          disposition: 'complete',
        },
      ],
      [
        makeOwnedPath('reviews', ['workspace', recordId('review', '0'), 'ledger.json']),
        { schemaVersion: 1, reviewId: recordId('review', '1'), entries: [] },
      ],
      [
        makeOwnedPath('reviews', ['coverage-actions', `${recordId('action', '0')}.json`]),
        {
          schemaVersion: 1,
          actionId: recordId('action', '1'),
          reviewId: recordId('review'),
          acceptedLimitations: [],
          settledWatermarks: {},
          createdAt: timestamp,
        },
      ],
      [
        makeOwnedPath('decisions', ['observations', `${recordId('decision', '0')}.json`]),
        {
          schemaVersion: 1,
          observationId: recordId('decision', '1'),
          reviewId: recordId('review'),
          reviewEntryId: recordId('entry'),
          subject: null,
          summary: 'Fixture',
          canonicalBranch: false,
          confidence: 'low',
          observedAt: timestamp,
        },
      ],
      [
        makeOwnedPath('decisions', ['actions', `${recordId('action', '0')}.json`]),
        {
          schemaVersion: 1,
          actionId: recordId('action', '1'),
          kind: 'confirm',
          observationIds: [recordId('decision')],
          actor: { kind: 'human' },
          createdAt: timestamp,
        },
      ],
    ]

    for (const [path, value] of mismatches) {
      expect(() => validatePublicRecord(path, value)).toThrow('owned path')
    }
  })
})
