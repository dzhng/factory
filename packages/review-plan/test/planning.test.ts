import { describe, expect, test } from 'bun:test'

import {
  canonicalJson,
  githubRepositoryKey,
  makeOwnedPath,
  newRecordId,
  reviewInputProblemId,
  reviewSubjectCoverageId,
} from '@factory/contract'
import type {
  AssociationBatch,
  AvailablePullRequestObservation,
  ObjectRef,
  RepositoryObservation,
  ReviewTrigger,
  SessionIdentity,
  TurnManifest,
} from '@factory/contract'
import { foldCoverage } from '@factory/domain'

import { emptyAuditSummary, writerChoice } from '../../test-harness/src/choice-fixtures'
import { planReviewForTesting as planReview, type ReviewInputs } from '../src'

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
      reviewer: { provider: 'codex', model: 'gpt-test', effort: 'high' },
      analyzerVersion: 'analyzer-v1',
      promptVersion: 'prompt-v1',
      policyVersion: 'policy-v1',
      formatVersion: 1,
    },
  }
}

describe('review planning', () => {
  test('accepts a complete Session Turn spanning other Sessions in the global journal', () => {
    const input = inputs()
    const value = candidate(3)
    input.subject = { kind: 'workspace', observation: observation(3) }
    value.turn.eventRange.first = 1
    value.events = [{ ...value.events[0]!, sequence: 1 }, value.events[0]!]
    value.turn.rawObjects = value.events.map(event => event.raw)
    input.candidates = [value]
    const plan = planReview(input)
    expect(plan.status).toBe('ready')
    expect(plan.sessions).toEqual([
      expect.objectContaining({ sessionKey: 'session-a', toInclusive: 3 }),
    ])
  })

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
        inputProblems: [],
        limitations: [],
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
        ledger: {
          schemaVersion: 1,
          reviewId: firstReviewId,
          entries: [],
          summary: emptyAuditSummary(writerChoice.evidence),
        },
      },
    ]
    const coverage = foldCoverage(input)
    expect(coverage.settledWatermarks).toEqual({ 'session-a': 1 })
    expect(() =>
      foldCoverage({ ...input, reviews: [input.reviews[0]!, input.reviews[0]!] }),
    ).toThrow('prior review identity is not unique')
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
        inputProblems: [],
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
        inputProblems: [],
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
        inputProblems: [],
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
      [2, 'previously-analyzed-complete'],
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
        inputProblems: [],
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
        inputProblems: [],
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
        inputProblems: [],
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
          inputProblems: [],
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
        inputProblems: [],
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
        inputProblems: [],
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
        acceptedProblemIds: [],
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
        coverageEffect: 'settled',
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
        inputProblems: [],
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
        acceptedProblemIds: [],
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

  test('does not replay unchanged readable partial evidence but retries it after recovery', () => {
    const input = inputs()
    const partialCandidate = candidate(2)
    partialCandidate.trigger = {
      ...partialCandidate.trigger,
      materialization: 'partial',
      limitations: [{ code: 'missing-transcript-range', detail: 'tail missing' }],
    }
    input.candidates = [partialCandidate]
    const first = planReview(input)
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: input.subject,
        subjectFingerprint: first.subjectFingerprint,
        subjectAttempt: settledSubject(first.subjectFingerprint),
        sessionWatermarks: first.sessionWatermarks,
        coverageTargetWatermarks: first.coverageTargetWatermarks,
        inputProblems: [],
        selections: first.selections,
        triggerIds: first.triggerIds,
        disposition: 'partial',
        policies: input.policies,
      },
    ]
    const unchanged = planReview(input)
    expect(unchanged.status).toBe('pending-partial')
    expect(unchanged.triggerIds).toEqual([])
    expect(unchanged.selections[0]?.coverageEffect).toBe('previously-analyzed-partial')
    input.candidates = [candidate(2)]
    const recovered = planReview(input)
    expect(recovered.status).toBe('ready')
    expect(recovered.triggerIds).toEqual([trigger(2).triggerId])
  })

  test('retries an unreviewed acquisition gap until explicit acceptance', () => {
    const input = inputs()
    const initial = planReview(input)
    const unavailableSelection = {
      ...initial.selections[0]!,
      selectedForReview: false,
      coverageEffect: 'eligible-gap' as const,
      classification: 'unavailable' as const,
      reason: 'missing',
      limitations: [{ code: 'missing-event-range' as const, detail: 'missing' }],
    }
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: input.subject,
        subjectFingerprint: initial.subjectFingerprint,
        subjectAttempt: settledSubject(initial.subjectFingerprint),
        sessionWatermarks: initial.sessionWatermarks,
        coverageTargetWatermarks: initial.coverageTargetWatermarks,
        inputProblems: [],
        selections: [unavailableSelection],
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
        limitations: [{ code: 'missing-event-range', detail: 'missing' }],
      },
    ]
    const retry = planReview(input)
    expect(retry.status).toBe('pending-partial')
    expect(retry.triggerIds).toEqual([trigger(2).triggerId])
    expect(retry.selections[0]?.coverageEffect).toBe('eligible-gap')
  })

  test('accepts one exact non-trigger problem without changing subject coverage', () => {
    const input = inputs()
    input.candidates = []
    const payload = {
      kind: 'association-batch' as const,
      path: makeOwnedPath('pull-requests', [
        'github',
        'repo',
        '1',
        'associations',
        'observation_00000000000000000000000000',
        'batches',
        'batch_00000000000000000000000000.json',
      ]),
      classification: 'corrupt' as const,
      limitation: { code: 'corrupt-input' as const, detail: 'bad batch' },
    }
    const problem = { ...payload, problemId: reviewInputProblemId(payload) }
    input.inputProblems = [problem]
    const first = planReview(input)
    expect(first.subjectAttempt.effect).toBe('current-included')
    input.reviews = [
      {
        reviewId: firstReviewId,
        subject: input.subject,
        subjectFingerprint: first.subjectFingerprint,
        subjectAttempt: first.subjectAttempt,
        sessionWatermarks: {},
        coverageTargetWatermarks: {},
        selections: [],
        inputProblems: [problem],
        triggerIds: [],
        disposition: 'partial',
        policies: input.policies,
      },
    ]
    input.coverageActions = [
      {
        schemaVersion: 1,
        actionId: id('coverage', 8),
        reviewId: firstReviewId,
        acceptedLimitations: ['corrupt-input'],
        acceptedTriggerIds: [],
        acceptedProblemIds: [problem.problemId],
        settledWatermarks: {},
        createdAt: '2026-09-05T00:00:08Z',
      },
    ]
    expect(planReview(input).status).toBe('already-reviewed')
    input.mode = 'force'
    expect(planReview(input).inputProblems).toEqual([problem])
    input.mode = 'incremental'
    input.inputProblems = []
    expect(planReview(input).status).toBe('already-reviewed')
  })

  test('includes completed manual PR association without relabeling it verified', () => {
    const input = inputs()
    const value = candidate(2)
    const repositoryKey = githubRepositoryKey('github.com', 'R_fixture')
    const pr: AvailablePullRequestObservation = {
      schemaVersion: 1,
      observationId: id('pr-observation', 2),
      provider: 'github',
      repositoryKey,
      number: 42,
      availability: 'available',
      completeness: 'partial',
      commitMembership: 'prefix',
      codeAvailability: 'unavailable',
      externalId: 'PR_42',
      hostname: 'github.com',
      url: 'https://github.com/owner/repo/pull/42',
      state: 'open',
      observedAt: '2026-09-05T00:00:02Z',
      providerUpdatedAt: '2026-09-05T00:00:02Z',
      base: {
        repositoryKey,
        externalId: 'R_fixture',
        repository: 'owner/repo',
        ref: 'main',
        sha: 'a'.repeat(40),
      },
      head: {
        repositoryKey,
        externalId: 'R_fixture',
        repository: 'owner/repo',
        ref: 'feature',
        sha: 'b'.repeat(40),
      },
      commits: [],
      evidence: [
        {
          ...ref('7', 'github-pr-metadata'),
          mediaType: 'application/json',
          role: 'github-pr-metadata',
        },
      ],
      diff: {
        ...ref('8', 'pull-request-diff'),
        mediaType: 'text/x-diff',
        role: 'pull-request-diff',
      },
      limitations: [
        { code: 'incomplete-pull-request-commits', detail: 'prefix only' },
        { code: 'unavailable-pull-request-code', detail: 'diff remains readable' },
      ],
    }
    const evidence = {
      schemaVersion: 1 as const,
      evidenceId: id('association', 2),
      sessionKey: value.trigger.sessionKey,
      pullRequestObservationId: pr.observationId,
      kind: 'manual' as const,
      strength: 'asserted' as const,
      shas: [] as [],
      repositoryIdentity: 'unavailable' as const,
      sourceObservationIds: [] as [],
      assertion: { actor: 'developer', reason: 'paired during review' },
      observedAt: pr.observedAt,
    }
    const batch: AssociationBatch = {
      schemaVersion: 1,
      batchId: id('association-batch', 2),
      provider: 'github',
      repositoryKey,
      number: 42,
      pullRequestObservationId: pr.observationId,
      kind: 'manual',
      evidence: [
        {
          evidenceId: evidence.evidenceId,
          sha256: Bun.CryptoHasher.hash(
            'sha256',
            new TextEncoder().encode(canonicalJson(evidence)),
            'hex',
          ),
        },
      ],
      sourceObservationIds: [],
      observedAt: pr.observedAt,
      policyVersion: 'manual-v1',
    }
    input.subject = { kind: 'pull-request', observation: pr }
    input.associations = [{ batch, evidence: [evidence] }]
    const plan = planReview(input)
    expect(plan.selections[0]?.association?.proofs).toEqual([
      {
        batchId: batch.batchId,
        evidenceId: evidence.evidenceId,
        authority: 'manual-asserted',
      },
    ])
    expect(plan.subjectReview).toBe('full-current-pr-diff')
  })
})
