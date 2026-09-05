import { describe, expect, test } from 'bun:test'

import {
  decisionAssertionFingerprint,
  type DecisionAction,
  type DecisionObservation,
  type JsonValue,
  type RecordId,
} from '@factory/contract'

import { foldDecisions } from '../src/decisions'

const id = (prefix: string, suffix: string) =>
  `${prefix}_${'0'.repeat(26 - suffix.length)}${suffix}` as RecordId
const at = (second: number) => `2026-09-05T00:00:${String(second).padStart(2, '0')}Z`

function observation(input: {
  suffix: string
  decisionKey?: string
  assertion: JsonValue
  effect?: DecisionObservation['effect']
  branch?: string
  source?: DecisionObservation['source']
}): DecisionObservation {
  const effect = input.effect ?? 'assert'
  return {
    schemaVersion: 1,
    observationId: id('decision', input.suffix),
    reviewId: id('review', input.suffix),
    reviewEntryId: id('entry', input.suffix),
    decisionKey: input.decisionKey ?? 'repository.writer',
    effect,
    assertion: input.assertion,
    assertionFingerprint: decisionAssertionFingerprint({ effect, assertion: input.assertion }),
    summary: `decision ${input.suffix}`,
    source:
      input.source ??
      ({ kind: 'workspace', branch: input.branch ?? 'main', exactSnapshot: true } as const),
    confidence: 'high',
    observedAt: at(Number(input.suffix)),
  }
}

function action(
  suffix: string,
  value: DecisionAction extends infer Action
    ? Action extends DecisionAction
      ? Omit<
          Action,
          | 'schemaVersion'
          | 'actionId'
          | 'previousActionId'
          | 'expectedStateFingerprint'
          | 'createdAt'
        >
      : never
    : never,
): DecisionAction {
  return {
    schemaVersion: 1,
    actionId: id('action', suffix),
    previousActionId: null,
    expectedStateFingerprint: '0'.repeat(64),
    createdAt: at(20 + Number(suffix)),
    ...value,
  } as DecisionAction
}

function preparedAction(
  suffix: string,
  value: Parameters<typeof action>[1],
  observations: readonly DecisionObservation[],
  actions: readonly DecisionAction[],
  createdAt?: string,
): DecisionAction {
  return {
    ...action(suffix, value),
    previousActionId: foldDecisions(observations, actions, 'main').actionHeadId ?? null,
    expectedStateFingerprint: foldDecisions(observations, actions, 'main').stateFingerprint,
    ...(createdAt === undefined ? {} : { createdAt }),
  }
}

describe('canonical decision fold', () => {
  const proposal = observation({
    suffix: '01',
    assertion: { owner: 'feature' },
    branch: 'feature/one-writer',
  })
  const canonical = observation({ suffix: '02', assertion: { owner: 'repository' } })
  const replay = observation({ suffix: '03', assertion: { owner: 'repository' } })
  const changed = observation({ suffix: '04', assertion: { owner: 'domain' } })

  test('keeps branch and PR evidence as proposals and exact configured workspace scope as canonical', () => {
    const pullRequest = observation({
      suffix: '05',
      assertion: { owner: 'pull-request' },
      source: {
        kind: 'pull-request',
        provider: 'github',
        repositoryKey: `ghr_${'a'.repeat(64)}`,
        number: 42,
        observationId: id('pr', '01'),
      },
    })
    const inexact = observation({
      suffix: '06',
      assertion: { owner: 'inexact' },
      source: { kind: 'workspace', branch: 'main', exactSnapshot: false },
    })
    const view = foldDecisions([proposal, pullRequest, inexact, canonical], [], 'main')
    expect(view.lineages[0]!.currentObservationId).toBe(canonical.observationId)
    expect(view.lineages[0]!.observations.map(item => item.scope)).toEqual([
      'proposal',
      'canonical',
      'proposal',
      'proposal',
    ])
    expect(
      foldDecisions([canonical], [], 'trunk').lineages[0]!.currentObservationId,
    ).toBeUndefined()
  })

  test('keeps confirmation exact to its target observation', () => {
    const observations = [proposal, canonical, replay, changed]
    const confirm = preparedAction(
      '01',
      {
        kind: 'confirm',
        targetObservationId: canonical.observationId,
        actor: { kind: 'human', label: 'David' },
      },
      observations,
      [],
    )
    const view = foldDecisions(observations, [confirm], 'main')
    const items = view.lineages[0]!.observations
    expect(items.map(item => item.lifecycle)).toEqual([
      'proposal',
      'canonical-current',
      'canonical-replay',
      'pending-supersession',
    ])
    expect(items[1]!.humanStatus).toBe('confirmed')
    expect(items[2]!.humanStatus).toBe('unconfirmed')
    expect(items[3]).toMatchObject({
      pendingReason: 'change',
      priority: 'high',
      humanStatus: 'unconfirmed',
    })
  })

  test('requires explicit removal and contradiction observations', () => {
    const removed = observation({ suffix: '05', assertion: null, effect: 'remove' })
    const contradicted = observation({
      suffix: '06',
      assertion: { claims: ['repository', 'review'] },
      effect: 'contradict',
    })
    const items = foldDecisions([canonical, removed, contradicted], [], 'main').lineages[0]!
      .observations
    expect(items.slice(1).map(item => [item.pendingReason, item.priority])).toEqual([
      ['removal', 'high'],
      ['contradiction', 'high'],
    ])
  })

  test('keeps a transition without a predecessor visible but invalid', () => {
    const removed = observation({ suffix: '05', assertion: null, effect: 'remove' })
    const confirm = preparedAction(
      '06',
      {
        kind: 'confirm',
        targetObservationId: removed.observationId,
        actor: { kind: 'human' },
      },
      [removed],
      [],
      at(7),
    )
    const view = foldDecisions([removed], [confirm], 'main')
    expect(view.lineages[0]!.observations[0]).toMatchObject({
      lifecycle: 'invalid',
      materiality: 'removal',
      priority: 'high',
    })
    expect(view.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'invalid-observation',
          observationId: removed.observationId,
        }),
        expect.objectContaining({
          kind: 'stale-action',
          actionId: confirm.actionId,
          reason: 'action target is absent or terminal',
        }),
      ]),
    )
  })

  test('applies append-only confirmation, dispute, resolution, rejection, and supersession', () => {
    const observations = [canonical, changed]
    const confirm = preparedAction(
      '01',
      {
        kind: 'confirm',
        targetObservationId: canonical.observationId,
        actor: { kind: 'human' },
      },
      observations,
      [],
    )
    const dispute = preparedAction(
      '02',
      {
        kind: 'dispute',
        targetObservationId: canonical.observationId,
        actor: { kind: 'human' },
        note: 'Ownership is contested',
      },
      observations,
      [confirm],
    )
    const resolve = preparedAction(
      '03',
      {
        kind: 'resolve',
        disputeActionId: dispute.actionId,
        actor: { kind: 'human' },
        note: 'The repository remains the writer',
      },
      observations,
      [confirm, dispute],
    )
    const supersede = preparedAction(
      '04',
      {
        kind: 'supersede',
        fromObservationId: canonical.observationId,
        toObservationId: changed.observationId,
        actor: { kind: 'human' },
        note: 'Move ownership deliberately',
      },
      observations,
      [confirm, dispute, resolve],
    )
    const superseded = foldDecisions(observations, [resolve, supersede, dispute, confirm], 'main')
    expect(superseded.lineages[0]).toMatchObject({ currentObservationId: changed.observationId })
    expect(superseded.lineages[0]!.observations.map(item => item.lifecycle)).toEqual([
      'superseded',
      'canonical-current',
    ])
    expect(superseded.lineages[0]!.observations[0]!.humanStatus).toBe('confirmed')
    expect(superseded.diagnostics).toEqual([])

    const reject = preparedAction(
      '05',
      {
        kind: 'reject',
        targetObservationId: changed.observationId,
        actor: { kind: 'human' },
      },
      observations,
      [],
    )
    expect(
      foldDecisions([canonical, changed], [reject], 'main').lineages[0]!.observations[1],
    ).toMatchObject({ lifecycle: 'rejected', priority: 'normal' })
  })

  test('is deterministic under input permutations and preserves stale actions as diagnostics', () => {
    const observations = [proposal, canonical, replay, changed]
    const reviewConfirmation = preparedAction(
      '01',
      {
        kind: 'confirm',
        targetObservationId: canonical.observationId,
        actor: { kind: 'review', reviewId: id('review', '09') },
      },
      observations,
      [],
    )
    const first = foldDecisions(observations, [reviewConfirmation], 'main')
    const shuffled = foldDecisions(
      [changed, replay, proposal, canonical],
      [reviewConfirmation],
      'main',
    )
    expect(shuffled).toEqual(first)
    expect(first.diagnostics).toEqual([
      expect.objectContaining({
        actionId: reviewConfirmation.actionId,
        kind: 'stale-action',
        reason: 'review actors cannot apply decision actions',
      }),
    ])
  })

  test('accepts only one action branch from the same merged parent', () => {
    const first = preparedAction(
      '01',
      {
        kind: 'confirm',
        targetObservationId: canonical.observationId,
        actor: { kind: 'human' },
      },
      [canonical],
      [],
      at(3),
    )
    const concurrent = preparedAction(
      '02',
      {
        kind: 'dispute',
        targetObservationId: canonical.observationId,
        actor: { kind: 'human' },
        note: 'Concurrent branch disagreed',
      },
      [canonical],
      [],
      at(4),
    )
    const view = foldDecisions([canonical], [concurrent, first], 'main')
    expect(view.actionHeadId).toBe(first.actionId)
    expect(view.lineages[0]!.observations[0]!.humanStatus).toBe('confirmed')
    expect(view.diagnostics).toContainEqual(
      expect.objectContaining({
        actionId: concurrent.actionId,
        reason: 'action was based on a different action head',
      }),
    )
  })

  test('applies actions in causal time before classifying later observations', () => {
    const replacement = observation({ suffix: '05', assertion: { owner: 'domain' } })
    const laterReplay = observation({ suffix: '07', assertion: { owner: 'domain' } })
    const supersede = preparedAction(
      '01',
      {
        kind: 'supersede',
        fromObservationId: canonical.observationId,
        toObservationId: replacement.observationId,
        actor: { kind: 'human' },
        note: 'Move the owner',
      },
      [canonical, replacement],
      [],
      at(6),
    )
    const view = foldDecisions([laterReplay, replacement, canonical], [supersede], 'main')
    expect(view.lineages[0]!.currentObservationId).toBe(replacement.observationId)
    expect(view.lineages[0]!.observations.map(item => item.lifecycle)).toEqual([
      'superseded',
      'canonical-current',
      'canonical-replay',
    ])
  })

  test('rebases unresolved alternatives after an explicit supersession', () => {
    const replacement = observation({ suffix: '05', assertion: { owner: 'domain' } })
    const removal = observation({ suffix: '06', assertion: null, effect: 'remove' })
    const supersede = preparedAction(
      '01',
      {
        kind: 'supersede',
        fromObservationId: canonical.observationId,
        toObservationId: replacement.observationId,
        actor: { kind: 'human' },
        note: 'Move the owner',
      },
      [canonical, replacement, removal],
      [],
      at(7),
    )
    const items = foldDecisions([canonical, replacement, removal], [supersede], 'main').lineages[0]!
      .observations
    expect(items[2]).toMatchObject({
      lifecycle: 'pending-supersession',
      pendingFromObservationId: replacement.observationId,
      pendingReason: 'removal',
    })
  })

  test('rejects actions against an old replay after its assertion is superseded', () => {
    const replay = observation({ suffix: '04', assertion: { owner: 'repository' } })
    const replacement = observation({ suffix: '05', assertion: { owner: 'domain' } })
    const supersede = preparedAction(
      '01',
      {
        kind: 'supersede',
        fromObservationId: canonical.observationId,
        toObservationId: replacement.observationId,
        actor: { kind: 'human' },
        note: 'Move the owner',
      },
      [canonical, replay, replacement],
      [],
      at(6),
    )
    const staleConfirmation = preparedAction(
      '02',
      {
        kind: 'confirm',
        targetObservationId: replay.observationId,
        actor: { kind: 'human' },
      },
      [canonical, replay, replacement],
      [supersede],
      at(7),
    )
    const view = foldDecisions(
      [canonical, replay, replacement],
      [supersede, staleConfirmation],
      'main',
    )
    expect(view.diagnostics).toContainEqual(
      expect.objectContaining({
        actionId: staleConfirmation.actionId,
        reason: 'action target is absent or terminal',
      }),
    )
  })

  test('keeps a dispute and resolution exact to the named observation', () => {
    const laterReplay = observation({ suffix: '06', assertion: { owner: 'repository' } })
    const confirm = preparedAction(
      '01',
      {
        kind: 'confirm',
        targetObservationId: canonical.observationId,
        actor: { kind: 'human' },
      },
      [canonical],
      [],
      at(3),
    )
    const dispute = preparedAction(
      '02',
      {
        kind: 'dispute',
        targetObservationId: canonical.observationId,
        actor: { kind: 'human' },
        note: 'Check this again',
      },
      [canonical],
      [confirm],
      at(4),
    )
    const resolve = preparedAction(
      '03',
      {
        kind: 'resolve',
        disputeActionId: dispute.actionId,
        actor: { kind: 'human' },
        note: 'Still correct',
      },
      [canonical, laterReplay],
      [confirm, dispute],
      at(7),
    )
    const items = foldDecisions([laterReplay, canonical], [resolve, dispute, confirm], 'main')
      .lineages[0]!.observations
    expect(items.map(item => item.humanStatus)).toEqual(['confirmed', 'unconfirmed'])
    expect(
      foldDecisions([canonical], [confirm, dispute, resolve], 'main').stateFingerprint,
    ).not.toBe(foldDecisions([canonical], [confirm], 'main').stateFingerprint)
  })
})
