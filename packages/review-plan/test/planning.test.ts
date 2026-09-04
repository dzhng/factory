import { describe, expect, test } from 'bun:test'

import { newRecordId, reviewSubjectCoverageId } from '@factory/contract'
import type {
  ObjectRef,
  RepositoryObservation,
  ReviewTrigger,
  SessionIdentity,
  TurnManifest,
} from '@factory/contract'

import { foldCoverage, planReview, type ReviewInputs } from '../src'

const firstReviewId = newRecordId('review', 0, new Uint8Array(10))
const secondReviewId = newRecordId('review', 1, new Uint8Array(10))
const settledSubject = (fingerprint: string) => ({
  fingerprint,
  coverageId: reviewSubjectCoverageId(fingerprint, []),
  effect: 'settled' as const,
  limitations: [],
})
const id = (prefix: string, watermark: number) => {
  const entropy = new Uint8Array(10)
  entropy[9] = watermark
  return newRecordId(prefix, watermark, entropy)
}

const ref = (sha256: string, role = 'raw'): ObjectRef => ({
  algorithm: 'sha256' as const,
  sha256: sha256.padEnd(64, '0'),
  bytes: 1,
  mediaType: 'application/octet-stream',
  role,
})

const trigger = (watermark: number): ReviewTrigger => ({
  schemaVersion: 1 as const,
  triggerId: id('trigger', watermark),
  sessionKey: 'session-a',
  turnId: id('turn', watermark),
  repositoryObservationId: id('observation', watermark),
  evidenceWatermark: watermark,
  provider: 'codex' as const,
  createdAt: `2026-09-05T00:00:0${watermark}Z`,
  materialization: 'complete' as const,
  limitations: [],
})

const identity = (): SessionIdentity => ({
  schemaVersion: 1,
  provider: 'codex',
  nativeSessionId: 'native-session-a',
  sessionKey: 'session-a',
  captureGeneration: 0,
  repositoryId: 'repo_test',
  firstObservedAt: '2026-09-05T00:00:00Z',
})

const candidate = (watermark: number) => ({
  identity: identity(),
  trigger: trigger(watermark),
  turn: turn(watermark),
  repositoryObservation: observation(watermark),
  events: [
    {
      sequence: watermark,
      observedAt: `2026-09-05T00:00:0${watermark}Z`,
      raw: turn(watermark).rawObjects[0]!,
    },
  ],
  transcript: [
    {
      sequence: watermark,
      observedAt: `2026-09-05T00:00:0${watermark}Z`,
      raw: turn(watermark).transcriptObservations[0]!,
    },
  ],
})

const turn = (watermark: number): TurnManifest => ({
  schemaVersion: 1 as const,
  turnId: id('turn', watermark),
  sessionKey: 'session-a',
  nativeStopId: `stop-${watermark}`,
  capturedAt: `2026-09-05T00:00:0${watermark}Z`,
  materializedAt: `2026-09-05T00:00:0${watermark}Z`,
  eventRange: { first: watermark, last: watermark },
  transcriptObservations: [ref(`${watermark}`)],
  rawObjects: [ref(`${watermark + 1}`)],
  repositoryObservationId: id('observation', watermark),
  limitations: [],
  captureAdapterVersion: 'capture-v1',
  formatVersion: 1 as const,
  inventory: [ref(`${watermark}`), ref(`${watermark + 1}`)],
})

const observation = (watermark: number): RepositoryObservation => ({
  schemaVersion: 1 as const,
  observationId: id('observation', watermark),
  repositoryId: 'repo_test' as const,
  observedAt: `2026-09-05T00:00:0${watermark}Z`,
  completedAt: `2026-09-05T00:00:0${watermark}Z`,
  git: { head: `head-${watermark}`, branch: 'feature', detached: false },
  changedPaths: [],
  worktreeFingerprint: `${watermark + 4}`.padEnd(64, '0'),
  codeManifest: {
    ...ref(`${watermark + 4}`, 'workspace-code-manifest'),
    mediaType: 'application/vnd.factory.code-manifest+json',
  },
  limitations: [],
  startState: `${watermark + 2}`.padEnd(64, '0'),
  endState: `${watermark + 2}`.padEnd(64, '0'),
})

function inputs(): ReviewInputs {
  return {
    mode: 'incremental',
    subject: { kind: 'workspace', observation: observation(2) },
    candidates: [candidate(2)],
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
  }
}

describe('review planning', () => {
  test('selects only the continuing Session range after complete coverage', () => {
    const input = inputs()
    const priorSubject = { kind: 'workspace' as const, observation: observation(1) }
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: priorSubject,
        subjectFingerprint: planReview({ ...inputs(), subject: priorSubject }).subjectFingerprint,
        subjectAttempt: settledSubject(
          planReview({ ...inputs(), subject: priorSubject }).subjectFingerprint,
        ),
        sessionWatermarks: { 'session-a': 1 },
        coverageTargetWatermarks: { 'session-a': 1 },
        selections: [
          {
            kind: 'range',
            selectedForReview: true,
            coverageEffect: 'eligible-included',
            sessionKey: 'session-a',
            triggerId: trigger(1).triggerId,
            turnId: turn(1).turnId,
            evidenceWatermark: 1,
            classification: 'included',
            reason: 'verified',
            limitations: [],
          },
        ],
        triggerIds: [trigger(1).triggerId],
        disposition: 'complete',
        policies: input.policies,
        head: 'head-1',
        codeManifest: undefined,
        ledger: { schemaVersion: 1, reviewId: firstReviewId, entries: [] },
      },
    ]
    const coverage = foldCoverage(input)
    expect(coverage.settledWatermarks).toEqual({ 'session-a': 1 })
    const plan = planReview(input)
    expect(plan.status).toBe('ready')
    expect(plan.sessions).toEqual([
      expect.objectContaining({ sessionKey: 'session-a', fromExclusive: 1, toInclusive: 2 }),
    ])
  })

  test('does not settle failed or unaccepted partial reviews', () => {
    const input = inputs()
    const fingerprint = planReview(input).subjectFingerprint
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: input.subject,
        subjectFingerprint: fingerprint,
        subjectAttempt: settledSubject(fingerprint),
        sessionWatermarks: { 'session-a': 2 },
        coverageTargetWatermarks: { 'session-a': 2 },
        selections: [
          {
            kind: 'range',
            selectedForReview: false,
            coverageEffect: 'eligible-gap',
            sessionKey: 'session-a',
            triggerId: trigger(2).triggerId,
            turnId: turn(2).turnId,
            evidenceWatermark: 2,
            classification: 'unavailable',
            reason: 'missing',
            limitations: [{ code: 'missing-event-range', detail: 'missing' }],
          },
        ],
        triggerIds: [trigger(2).triggerId],
        disposition: 'partial',
        policies: input.policies,
        ledger: { schemaVersion: 1, reviewId: firstReviewId, entries: [] },
      },
      {
        reviewId: secondReviewId,
        subject: input.subject,
        subjectFingerprint: fingerprint,
        subjectAttempt: settledSubject(fingerprint),
        sessionWatermarks: { 'session-a': 3 },
        coverageTargetWatermarks: { 'session-a': 3 },
        selections: [
          {
            kind: 'range',
            selectedForReview: true,
            coverageEffect: 'eligible-included',
            sessionKey: 'session-a',
            triggerId: trigger(3).triggerId,
            turnId: turn(3).turnId,
            evidenceWatermark: 3,
            classification: 'included',
            reason: 'included',
            limitations: [],
          },
        ],
        triggerIds: [trigger(3).triggerId],
        disposition: 'failed',
        policies: input.policies,
      },
    ]
    expect(foldCoverage(input).settledWatermarks).toEqual({})
  })

  test('retries a recovered hole without re-reviewing readable later evidence', () => {
    const input = inputs()
    input.candidates = [candidate(1), ...input.candidates]
    const fingerprint = planReview(input).subjectFingerprint
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: input.subject,
        subjectFingerprint: fingerprint,
        subjectAttempt: settledSubject(fingerprint),
        sessionWatermarks: { 'session-a': 2 },
        coverageTargetWatermarks: { 'session-a': 2 },
        selections: [
          {
            kind: 'range',
            selectedForReview: false,
            coverageEffect: 'eligible-gap',
            sessionKey: 'session-a',
            triggerId: trigger(1).triggerId,
            turnId: turn(1).turnId,
            evidenceWatermark: 1,
            classification: 'unavailable',
            reason: 'missing-range',
            limitations: [{ code: 'missing-event-range', detail: 'first Stop missing' }],
          },
          {
            kind: 'range',
            selectedForReview: true,
            coverageEffect: 'eligible-included',
            sessionKey: 'session-a',
            triggerId: trigger(2).triggerId,
            turnId: turn(2).turnId,
            evidenceWatermark: 2,
            classification: 'included',
            reason: 'verified',
            limitations: [],
          },
        ],
        triggerIds: [trigger(1).triggerId, trigger(2).triggerId].sort(),
        disposition: 'partial',
        policies: input.policies,
      },
    ]
    const plan = planReview(input)
    expect(
      plan.selections.map(item => [
        item.kind === 'range' ? item.evidenceWatermark : null,
        item.reason,
      ]),
    ).toEqual([
      [1, 'included'],
      [2, 'previously-reviewed-range'],
    ])
    expect(plan.triggerIds).toEqual([trigger(1).triggerId])
  })

  test('subject change reviews full current code without replaying covered evidence', () => {
    const input = inputs()
    const priorSubject = { kind: 'workspace' as const, observation: observation(1) }
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: priorSubject,
        subjectFingerprint: planReview({ ...inputs(), subject: priorSubject }).subjectFingerprint,
        subjectAttempt: settledSubject(
          planReview({ ...inputs(), subject: priorSubject }).subjectFingerprint,
        ),
        sessionWatermarks: { 'session-a': 2 },
        coverageTargetWatermarks: { 'session-a': 2 },
        selections: [
          {
            kind: 'range',
            selectedForReview: true,
            coverageEffect: 'eligible-included',
            sessionKey: 'session-a',
            triggerId: trigger(2).triggerId,
            turnId: turn(2).turnId,
            evidenceWatermark: 2,
            classification: 'included',
            reason: 'verified',
            limitations: [],
          },
        ],
        triggerIds: [trigger(2).triggerId],
        disposition: 'complete',
        policies: input.policies,
      },
    ]
    const plan = planReview(input)
    expect(plan.subjectReview).toBe('full-current-code')
    expect(plan.replayCoveredEvidence).toBe(false)
    expect(plan.triggerIds).toEqual([])
    input.mode = 'full'
    expect(planReview(input).triggerIds).toEqual([trigger(2).triggerId])
  })

  test('semantic fingerprint ignores observation identity', () => {
    const first = inputs()
    const second = inputs()
    second.subject = {
      kind: 'workspace',
      observation: { ...observation(2), observationId: observation(3).observationId },
    }
    expect(planReview(first).subjectFingerprint).toBe(planReview(second).subjectFingerprint)
  })

  test('complete coverage rejects readable partial evidence', () => {
    const input = inputs()
    const fingerprint = planReview(input).subjectFingerprint
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: input.subject,
        subjectFingerprint: fingerprint,
        subjectAttempt: settledSubject(fingerprint),
        sessionWatermarks: { 'session-a': 2 },
        coverageTargetWatermarks: { 'session-a': 2 },
        selections: [
          {
            kind: 'range',
            selectedForReview: true,
            coverageEffect: 'eligible-gap',
            sessionKey: 'session-a',
            triggerId: trigger(2).triggerId,
            turnId: turn(2).turnId,
            evidenceWatermark: 2,
            classification: 'readable-partial',
            reason: 'partial',
            limitations: [{ code: 'missing-transcript-range', detail: 'tail unavailable' }],
          },
        ],
        triggerIds: [trigger(2).triggerId],
        disposition: 'complete',
        policies: input.policies,
      },
    ]
    expect(() => foldCoverage(input)).toThrow('unsettled evidence selection')
  })

  test('coverage from another workspace repository does not suppress a Session', () => {
    const input = inputs()
    const otherSubject = {
      kind: 'workspace' as const,
      observation: { ...observation(2), repositoryId: 'repo_other' as const },
    }
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: otherSubject,
        subjectFingerprint: planReview({ ...inputs(), subject: otherSubject }).subjectFingerprint,
        subjectAttempt: settledSubject(
          planReview({ ...inputs(), subject: otherSubject }).subjectFingerprint,
        ),
        sessionWatermarks: { 'session-a': 2 },
        coverageTargetWatermarks: { 'session-a': 2 },
        selections: [
          {
            kind: 'range',
            selectedForReview: true,
            coverageEffect: 'eligible-included',
            sessionKey: 'session-a',
            triggerId: trigger(2).triggerId,
            turnId: turn(2).turnId,
            evidenceWatermark: 2,
            classification: 'included',
            reason: 'verified',
            limitations: [],
          },
        ],
        triggerIds: [trigger(2).triggerId],
        disposition: 'complete',
        policies: input.policies,
      },
    ]
    expect(planReview(input).triggerIds).toEqual([trigger(2).triggerId])
  })

  test('each policy-version component refreshes code without replaying covered evidence', () => {
    for (const key of ['analyzerVersion', 'promptVersion', 'policyVersion'] as const) {
      const input = inputs()
      const initial = planReview(input)
      input.reviews = [
        {
          reviewId: firstReviewId,
          subject: input.subject,
          subjectFingerprint: initial.subjectFingerprint,
          subjectAttempt: settledSubject(initial.subjectFingerprint),
          sessionWatermarks: { 'session-a': 2 },
          coverageTargetWatermarks: { 'session-a': 2 },
          selections: initial.selections,
          triggerIds: initial.triggerIds,
          disposition: 'complete',
          policies: input.policies,
        },
      ]
      input.policies = { ...input.policies, [key]: `${input.policies[key]}-changed` }
      const plan = planReview(input)
      expect(plan.fullReviewReason).toBe('policy-changed')
      expect(plan.replayCoveredEvidence).toBe(false)
      expect(plan.triggerIds).toEqual([])
    }
  })

  test('unaccepted unreadable evidence waits without claiming already reviewed', () => {
    const input = inputs()
    const initial = planReview(input)
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: input.subject,
        subjectFingerprint: initial.subjectFingerprint,
        subjectAttempt: settledSubject(initial.subjectFingerprint),
        sessionWatermarks: { 'session-a': 2 },
        coverageTargetWatermarks: { 'session-a': 2 },
        selections: [
          {
            ...initial.selections[0]!,
            selectedForReview: false,
            coverageEffect: 'eligible-gap',
            classification: 'unavailable',
            reason: 'missing',
            limitations: [{ code: 'missing-event-range', detail: 'not recovered' }],
          },
        ],
        triggerIds: initial.triggerIds,
        disposition: 'partial',
        policies: input.policies,
      },
    ]
    input.candidates = [
      {
        kind: 'range',
        sessionKey: 'session-a',
        triggerId: trigger(2).triggerId,
        turnId: turn(2).turnId,
        evidenceWatermark: 2,
        scopeProof: { kind: 'workspace-store', repositoryId: 'repo_test' },
        availability: 'unavailable',
        limitations: [{ code: 'missing-event-range', detail: 'not recovered' }],
      },
    ]
    expect(planReview(input).status).toBe('pending-partial')
  })

  test('reviews readable subject code even when no Session evidence is available', () => {
    const input = inputs()
    input.candidates = []
    const plan = planReview(input)
    expect(plan.status).toBe('ready')
    expect(plan.subjectReview).toBe('full-current-code')
    expect(plan.fullReviewReason).toBe('initial-review')
    expect(plan.triggerIds).toEqual([])
  })

  test('accepts an opaque corrupt trigger without inventing a Session watermark', () => {
    const input = inputs()
    const opaqueTrigger = id('trigger', 8)
    const initial = planReview(input)
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: input.subject,
        subjectFingerprint: initial.subjectFingerprint,
        subjectAttempt: settledSubject(initial.subjectFingerprint),
        sessionWatermarks: {},
        coverageTargetWatermarks: {},
        selections: [
          {
            kind: 'opaque-problem',
            triggerId: opaqueTrigger,
            selectedForReview: false,
            coverageEffect: 'eligible-gap',
            classification: 'corrupt',
            reason: 'corrupt-trigger',
            limitations: [{ code: 'corrupt-input', detail: 'invalid trigger bytes' }],
          },
        ],
        triggerIds: [opaqueTrigger],
        disposition: 'partial',
        policies: input.policies,
      },
    ]
    input.coverageActions = [
      {
        schemaVersion: 1,
        actionId: id('coverage', 9),
        reviewId: firstReviewId,
        acceptedLimitations: ['corrupt-input'],
        acceptedTriggerIds: [opaqueTrigger],
        settledWatermarks: {},
        createdAt: '2026-09-05T00:00:09Z',
      },
    ]
    input.candidates = [
      {
        kind: 'opaque-problem',
        triggerId: opaqueTrigger,
        scopeProof: { kind: 'workspace-store', repositoryId: 'repo_test' },
        availability: 'corrupt',
        limitations: [{ code: 'corrupt-input', detail: 'invalid trigger bytes' }],
      },
    ]
    const plan = planReview(input)
    expect(plan.sessionWatermarks).toEqual({})
    expect(plan.triggerIds).toEqual([])
    expect(plan.selections[0]).toEqual(
      expect.objectContaining({
        kind: 'opaque-problem',
        coverageEffect: 'previously-analyzed',
      }),
    )
    expect(plan.status).toBe('already-reviewed')
  })

  test('admits verified evidence before weak context under the Session limit', () => {
    const input = inputs()
    const weak = candidate(1)
    const verified = candidate(2)
    verified.identity = { ...verified.identity, sessionKey: 'session-z' }
    verified.trigger = { ...verified.trigger, sessionKey: 'session-z' }
    verified.turn = { ...verified.turn, sessionKey: 'session-z' }
    input.candidates = [weak, verified]
    input.reviewLimits = { maxSessions: 1 }
    const plan = planReview(input)
    expect(
      Object.fromEntries(
        plan.selections.map(selection => [selection.triggerId, selection.coverageEffect]),
      ),
    ).toEqual({
      [weak.trigger.triggerId]: 'deferred-by-limit',
      [verified.trigger.triggerId]: 'eligible-included',
    })
    expect(plan.sessionWatermarks).toEqual({ 'session-z': 2 })
  })

  test('keeps a raced readable subject pending until its exact limitations are accepted', () => {
    const input = inputs()
    input.candidates = []
    input.subject = {
      kind: 'workspace',
      observation: {
        ...observation(2),
        limitations: [{ code: 'repository-race', detail: 'changed during observation' }],
      },
    }
    const first = planReview(input)
    expect(first.status).toBe('ready')
    expect(first.subjectAttempt.effect).toBe('reviewed-partial')
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: input.subject,
        subjectFingerprint: first.subjectFingerprint,
        subjectAttempt: first.subjectAttempt,
        sessionWatermarks: {},
        coverageTargetWatermarks: {},
        selections: [],
        triggerIds: [],
        disposition: 'partial',
        policies: input.policies,
      },
    ]
    expect(planReview(input).status).toBe('pending-partial')
    input.coverageActions = [
      {
        schemaVersion: 1,
        actionId: id('coverage', 4),
        reviewId: firstReviewId,
        acceptedLimitations: [],
        acceptedTriggerIds: [],
        acceptedSubject: {
          fingerprint: first.subjectFingerprint,
          coverageId: first.subjectAttempt.coverageId,
          limitations: ['repository-race'],
        },
        settledWatermarks: {},
        createdAt: '2026-09-05T00:00:04Z',
      },
    ]
    expect(planReview(input).status).toBe('already-reviewed')
    input.coverageActions = []
    input.subject = {
      kind: 'workspace',
      observation: { ...input.subject.observation, limitations: [] },
    }
    const recovered = planReview(input)
    expect(recovered.status).toBe('ready')
    expect(recovered.fullReviewReason).toBe('limitations-changed')
  })
})
