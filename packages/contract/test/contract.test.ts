import { describe, expect, test } from 'bun:test'

import {
  canonicalJson,
  decodeGitPath,
  encodeGitPath,
  githubRepositoryKey,
  makeOwnedPath,
  newRecordId,
  parseCodeManifest,
  parseRepositoryConfig,
  parseRepositoryManifest,
  reviewSubjectCoverageId,
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

  test('validates reconstructable code manifests as byte-sorted public data', () => {
    const object = {
      algorithm: 'sha256' as const,
      sha256: '0'.repeat(64),
      bytes: 1,
      mediaType: 'application/octet-stream',
      role: 'workspace-file',
    }
    const valid = {
      schemaVersion: 1 as const,
      entries: [
        {
          path: encodeGitPath(Buffer.from('a')),
          mode: '100644' as const,
          kind: 'file' as const,
          object,
        },
        {
          path: encodeGitPath(Buffer.from([0x62, 0xff])),
          mode: '100755' as const,
          kind: 'file' as const,
          object,
        },
      ],
      limitations: [],
    }
    expect(parseCodeManifest(valid)).toEqual(valid)
    expect(() => parseCodeManifest({ ...valid, entries: [...valid.entries].reverse() })).toThrow(
      'byte-sorted',
    )
    expect(() =>
      parseCodeManifest({
        ...valid,
        entries: [{ ...valid.entries[0], path: encodeGitPath(Buffer.from('../escape')) }],
      }),
    ).toThrow('traversal')
    expect(() =>
      parseCodeManifest({
        ...valid,
        entries: [
          { path: encodeGitPath(Buffer.from('sub')), mode: '160000', kind: 'gitlink', object },
        ],
      }),
    ).toThrow('gitlink shape')
    expect(() =>
      parseCodeManifest({
        ...valid,
        entries: [
          valid.entries[0],
          { ...valid.entries[1], path: encodeGitPath(Buffer.from('a/child')) },
        ],
      }),
    ).toThrow('ancestor path collision')
    expect(() =>
      parseCodeManifest({
        ...valid,
        entries: [
          {
            ...valid.entries[0],
            object: { ...object, role: 'git-lfs-pointer' },
          },
        ],
      }),
    ).toThrow('file object semantics')
    expect(() =>
      parseCodeManifest({
        ...valid,
        entries: [{ ...valid.entries[0]!, path: { ...valid.entries[0]!.path, display: 42 } }],
      }),
    ).toThrow('display')
    expect(() =>
      parseCodeManifest({
        ...valid,
        entries: [{ ...valid.entries[0]!, path: encodeGitPath(Buffer.from('.git/config')) }],
      }),
    ).toThrow('reserved repository namespace')
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
          githubRepositoryKey('github.com', 'R_fixture'),
          '42',
          'observations',
          `${recordId('observation')}.json`,
        ]),
        {
          schemaVersion: 1,
          observationId: recordId('observation'),
          provider: 'github',
          repositoryKey: githubRepositoryKey('github.com', 'R_fixture'),
          number: 42,
          availability: 'available',
          codeAvailability: 'unavailable',
          externalId: 'PR_42',
          hostname: 'github.com',
          url: 'https://github.com/owner/repo/pull/42',
          state: 'open',
          base: {
            repositoryKey: githubRepositoryKey('github.com', 'R_fixture'),
            externalId: 'R_fixture',
            repository: 'owner/repo',
            ref: 'main',
            sha: hash,
          },
          head: {
            repositoryKey: githubRepositoryKey('github.com', 'R_fixture'),
            externalId: 'R_fixture',
            repository: 'owner/repo',
            ref: 'feature',
            sha: hash,
          },
          commits: [hash],
          completeness: 'complete',
          commitMembership: 'complete',
          observedAt: timestamp,
          providerUpdatedAt: timestamp,
          raw: [{ ...object, mediaType: 'application/json', role: 'github-pr-metadata' }],
          diff: { ...object, mediaType: 'text/x-diff', role: 'pull-request-diff' },
          limitations: [
            { code: 'unavailable-pull-request-code', detail: 'Fixture has no code manifest' },
          ],
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
          coverageTargetWatermarks: { session_01: 1 },
          subjectFingerprint: hash,
          subjectAttempt: {
            fingerprint: hash,
            coverageId: reviewSubjectCoverageId(hash, []),
            effect: 'current-included',
            limitations: [],
          },
          evidenceSelections: [
            {
              kind: 'range',
              sessionKey: 'session_01',
              triggerId: recordId('trigger'),
              turnId: recordId('turn'),
              evidenceWatermark: 1,
              selectedForReview: true,
              coverageEffect: 'eligible-included',
              classification: 'included',
              reason: 'verified',
              limitations: [],
            },
          ],
          triggerIds: [recordId('trigger')],
          associationBatchIds: [],
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
          acceptedTriggerIds: [],
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

  test('keeps unavailable pull requests distinct from exact observations', () => {
    const observedAt = '2026-09-04T00:00:00Z'
    const sha = '0'.repeat(40)
    const observationId = recordId('pr-observation')
    const repositoryKey = githubRepositoryKey('github.com', 'R_base')
    const path = makeOwnedPath('pull-requests', [
      'github',
      repositoryKey,
      '42',
      'observations',
      `${observationId}.json`,
    ])
    const unavailable = {
      schemaVersion: 1,
      observationId,
      provider: 'github',
      repositoryKey,
      number: 42,
      availability: 'unavailable',
      reason: 'authentication-required',
      hostname: 'github.com',
      base: { repositoryKey, externalId: 'R_base', repository: 'owner/repo' },
      observedAt,
      raw: [
        {
          algorithm: 'sha256',
          sha256: '0'.repeat(64),
          bytes: 1,
          mediaType: 'application/json',
          role: 'github-pr-metadata',
        },
      ],
      limitations: [{ code: 'unavailable-pull-request', detail: 'gh is not authenticated' }],
    }
    expect(() => validatePublicRecord(path, unavailable)).not.toThrow()
    expect(() =>
      validatePublicRecord(path, {
        ...unavailable,
        head: { repositoryKey, ref: 'feature', sha },
      }),
    ).toThrow('unknown fields')
    expect(() => validatePublicRecord(path, { ...unavailable, raw: [] })).toThrow('raw GitHub')
    expect(() =>
      validatePublicRecord(path, {
        ...unavailable,
        raw: [{ ...unavailable.raw[0], role: 'wrong' }],
      }),
    ).toThrow('raw GitHub')
    const inventedKey = githubRepositoryKey('github.com', 'R_invented')
    expect(() =>
      validatePublicRecord(
        makeOwnedPath('pull-requests', [
          'github',
          inventedKey,
          '42',
          'observations',
          `${observationId}.json`,
        ]),
        {
          ...unavailable,
          repositoryKey: inventedKey,
          base: { ...unavailable.base, repositoryKey: inventedKey },
        },
      ),
    ).toThrow('not canonical')
  })

  test('validates manual PR association evidence without calling it verified', () => {
    const observedAt = '2026-09-04T00:00:00Z'
    const observationId = recordId('pr-observation')
    const evidenceId = recordId('association')
    const repositoryKey = 'ghr_b3duZXIvcmVwbw'
    const path = makeOwnedPath('pull-requests', [
      'github',
      repositoryKey,
      '42',
      'associations',
      observationId,
      `${evidenceId}.json`,
    ])
    expect(() =>
      validatePublicRecord(path, {
        schemaVersion: 1,
        evidenceId,
        sessionKey: 'session_01',
        pullRequestObservationId: observationId,
        kind: 'manual',
        strength: 'asserted',
        shas: [],
        repositoryIdentity: 'unavailable',
        sourceObservationIds: [],
        assertion: { actor: 'developer', reason: 'paired during review' },
        observedAt,
      }),
    ).not.toThrow()
  })

  test('binds exact PR evidence to its base repository and semantic raw objects', () => {
    const observedAt = '2026-09-04T00:00:00Z'
    const observationId = recordId('pr-observation')
    const repositoryKey = githubRepositoryKey('github.com', 'R_base')
    const path = makeOwnedPath('pull-requests', [
      'github',
      repositoryKey,
      '42',
      'observations',
      `${observationId}.json`,
    ])
    const object = {
      algorithm: 'sha256',
      sha256: '0'.repeat(64),
      bytes: 1,
      mediaType: 'application/json',
      role: 'github-pr-metadata',
    }
    const valid = {
      schemaVersion: 1,
      observationId,
      provider: 'github',
      repositoryKey,
      number: 42,
      availability: 'available',
      codeAvailability: 'unavailable',
      externalId: 'PR_42',
      hostname: 'github.com',
      url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      base: {
        repositoryKey,
        externalId: 'R_base',
        repository: 'owner/repo',
        ref: 'main',
        sha: '1'.repeat(40),
      },
      head: {
        repositoryKey: githubRepositoryKey('github.com', 'R_fork'),
        externalId: 'R_fork',
        repository: 'contributor/repo',
        ref: 'feature',
        sha: '2'.repeat(40),
      },
      commits: ['2'.repeat(40)],
      completeness: 'complete',
      commitMembership: 'complete',
      observedAt,
      providerUpdatedAt: observedAt,
      raw: [object],
      diff: { ...object, mediaType: 'text/x-diff', role: 'pull-request-diff' },
      limitations: [
        { code: 'unavailable-pull-request-code', detail: 'Fixture has no code manifest' },
      ],
    }
    expect(() => validatePublicRecord(path, valid)).not.toThrow()
    expect(() =>
      validatePublicRecord(path, {
        ...valid,
        codeAvailability: 'not-requested',
        limitations: [],
      }),
    ).not.toThrow()
    expect(() => validatePublicRecord(path, { ...valid, codeAvailability: 'captured' })).toThrow(
      'code availability',
    )
    expect(() =>
      validatePublicRecord(path, {
        ...valid,
        base: {
          ...valid.base,
          repositoryKey: githubRepositoryKey('github.com', 'R_other'),
          externalId: 'R_other',
        },
      }),
    ).toThrow('base repository')
    expect(() => validatePublicRecord(path, { ...valid, raw: [] })).toThrow('raw evidence')
    expect(() => validatePublicRecord(path, { ...valid, diff: object })).toThrow('diff semantics')
    for (const url of [
      'https://github.com/other/repo/pull/42',
      'https://github.com/owner/repo/pull/41',
      'https://user:secret@github.com/owner/repo/pull/42',
      'https://github.com/owner/repo/pull/42?view=files',
      'https://github.com/owner/repo/pull/42#discussion',
    ]) {
      expect(() => validatePublicRecord(path, { ...valid, url })).toThrow()
    }
    expect(() =>
      validatePublicRecord(path, {
        ...valid,
        head: { ...valid.head, repository: 'contributor/repo/extra' },
      }),
    ).toThrow('head.repository is invalid')
    expect(() =>
      validatePublicRecord(path, {
        ...valid,
        completeness: 'partial',
        commitMembership: 'prefix',
      }),
    ).toThrow('must agree')
    expect(() =>
      validatePublicRecord(path, {
        ...valid,
        completeness: 'partial',
        commitMembership: 'prefix',
        limitations: [
          ...valid.limitations,
          { code: 'incomplete-pull-request-commits', detail: 'bounded prefix' },
        ],
      }),
    ).not.toThrow()
    expect(() =>
      validatePublicRecord(path, {
        ...valid,
        limitations: [
          ...valid.limitations,
          { code: 'incomplete-pull-request-commits', detail: 'contradiction' },
        ],
      }),
    ).toThrow('cannot claim incomplete')
    expect(() =>
      validatePublicRecord(path, {
        ...valid,
        completeness: 'partial',
        commitMembership: 'complete',
        head: {
          repositoryKey: githubRepositoryKey('github.com', 'R_fork'),
          externalId: 'R_fork',
          repository: 'contributor/repo',
        },
        limitations: [
          ...valid.limitations,
          { code: 'incomplete-pull-request-refs', detail: 'deleted ref' },
        ],
      }),
    ).not.toThrow()
    expect(() =>
      validatePublicRecord(path, {
        ...valid,
        completeness: 'partial',
        commitMembership: 'complete',
        head: {
          repositoryKey: githubRepositoryKey('github.com', 'R_fork'),
          externalId: 'R_fork',
          repository: 'contributor/repo',
          sha: '3'.repeat(40),
        },
        limitations: [
          ...valid.limitations,
          { code: 'incomplete-pull-request-refs', detail: 'deleted ref' },
        ],
      }),
    ).toThrow('membership must contain head')
  })

  test('validates provider-derived repository mappings and completed association batches', () => {
    const observedAt = '2026-09-04T00:00:00Z'
    const mappingId = recordId('github-repository-mapping')
    const repositoryKey = githubRepositoryKey('github.com', 'R_base')
    const repositoryId = 'repo_local'
    const raw = {
      algorithm: 'sha256',
      sha256: '4'.repeat(64),
      bytes: 1,
      mediaType: 'application/json',
      role: 'github-repository-metadata',
    }
    const mappingPath = makeOwnedPath('pull-requests', [
      'github',
      repositoryKey,
      'repository-mappings',
      repositoryId,
      `${mappingId}.json`,
    ])
    const mapping = {
      schemaVersion: 1,
      observationId: mappingId,
      provider: 'github',
      repositoryId,
      repositoryKey,
      externalId: 'R_base',
      hostname: 'github.com',
      repository: 'owner/repo',
      url: 'https://github.com/owner/repo',
      observedAt,
      raw: [raw],
    }
    expect(() => validatePublicRecord(mappingPath, mapping)).not.toThrow()
    for (const url of [
      'https://github.com/other/repo',
      'https://user:secret@github.com/owner/repo',
      'https://github.com/owner/repo?view=files',
      'https://github.com/owner/repo#readme',
    ]) {
      expect(() => validatePublicRecord(mappingPath, { ...mapping, url })).toThrow()
    }
    expect(() =>
      validatePublicRecord(mappingPath, {
        ...mapping,
        repository: 'owner/repo/extra',
        url: 'https://github.com/owner/repo/extra',
      }),
    ).toThrow('repository is invalid')

    const observationId = recordId('pr-observation')
    const evidenceId = recordId('association')
    const batchId = recordId('association-batch')
    const batchPath = makeOwnedPath('pull-requests', [
      'github',
      repositoryKey,
      '42',
      'associations',
      observationId,
      'batches',
      `${batchId}.json`,
    ])
    const batch = {
      schemaVersion: 1,
      batchId,
      provider: 'github',
      repositoryKey,
      number: 42,
      pullRequestObservationId: observationId,
      kind: 'automatic',
      evidence: [{ evidenceId, sha256: '5'.repeat(64) }],
      sourceObservationIds: [mappingId],
      observedAt,
      policyVersion: 'factory-v1-exact-git-v1',
    }
    expect(() => validatePublicRecord(batchPath, batch)).not.toThrow()
    expect(() =>
      validatePublicRecord(batchPath, {
        ...batch,
        evidence: [...batch.evidence, batch.evidence[0]],
      }),
    ).toThrow('unique')
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
          repositoryKey: githubRepositoryKey('github.com', 'R_other'),
          number: 43,
          availability: 'available',
          codeAvailability: 'unavailable',
          externalId: 'PR_43',
          hostname: 'github.com',
          url: 'https://github.com/other/repo/pull/43',
          state: 'open',
          base: {
            repositoryKey: githubRepositoryKey('github.com', 'R_other'),
            externalId: 'R_other',
            repository: 'other/repo',
            ref: 'main',
            sha: hash,
          },
          head: {
            repositoryKey: githubRepositoryKey('github.com', 'R_other'),
            externalId: 'R_other',
            repository: 'other/repo',
            ref: 'feature',
            sha: hash,
          },
          commits: [hash],
          completeness: 'complete',
          commitMembership: 'complete',
          observedAt: timestamp,
          providerUpdatedAt: timestamp,
          raw: [{ ...object, mediaType: 'application/json', role: 'github-pr-metadata' }],
          diff: { ...object, mediaType: 'text/x-diff', role: 'pull-request-diff' },
          limitations: [
            { code: 'unavailable-pull-request-code', detail: 'Fixture has no code manifest' },
          ],
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
          coverageTargetWatermarks: {},
          subjectFingerprint: hash,
          subjectAttempt: {
            fingerprint: hash,
            coverageId: reviewSubjectCoverageId(hash, []),
            effect: 'current-included',
            limitations: [],
          },
          evidenceSelections: [],
          triggerIds: [],
          associationBatchIds: [],
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
          acceptedTriggerIds: [],
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
