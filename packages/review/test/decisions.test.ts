import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  canonicalJson,
  type DecisionAction,
  type DecisionObservation,
  type JsonValue,
  type OwnedPath,
  type RecordId,
} from '@factory/contract'
import { foldDecisions } from '@factory/domain'
import { DecisionAuthorityConflictError, type RepositoryStore } from '@factory/repository'
import { openVerifiedReviewBundle, readVerifiedReviewBundle } from '@factory/reviewer'

import { sealReviewerRawAttempt } from '../../reviewer/src/attempt'
import {
  acceptReview,
  appendDecisionAction,
  StaleDecisionActionError,
  validateReview,
} from '../src'

const id = (prefix: string, suffix: string) =>
  `${prefix}_${'0'.repeat(26 - suffix.length)}${suffix}` as RecordId

async function fixture() {
  const root = join(import.meta.dir, '../../../specs/done/factory-v1/assets/review-plan')
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as {
    bundles: { complete: string }
  }
  const bundle = await openVerifiedReviewBundle(
    join(root, 'complete-bundle'),
    report.bundles.complete,
  )
  const verified = await readVerifiedReviewBundle(bundle)
  const citation = verified.manifest.inventory[0]!
  const reviewId = id('review', '8')
  const response = [
    {
      kind: 'decision',
      decisionKey: 'repository.writer',
      effect: 'assert',
      assertion: { owner: 'repository' },
      confidence: 'high',
      summary: 'Repository owns writes',
      evidence: [{ object: citation }],
    },
    {
      kind: 'decision',
      decisionKey: 'repository.writer',
      effect: 'assert',
      assertion: { owner: 'domain' },
      confidence: 'high',
      summary: 'Domain owns writes',
      evidence: [{ object: citation }],
    },
  ]
    .map(value => JSON.stringify(value))
    .join('\n')
  const validated = await validateReview(
    bundle,
    sealReviewerRawAttempt({
      reviewId,
      bundleSha256: verified.sha256,
      response: new TextEncoder().encode(`${response}\n`),
      termination: 'completed',
      exitCode: 0,
      outputTruncated: false,
      reviewer: { settings: verified.manifest.plan.policies.reviewer },
      imageDigest: `sha256:${'b'.repeat(64)}`,
      providerCliVersion: 'test',
      hostPlatform: 'test',
      startedAt: '2026-09-05T00:00:00Z',
      completedAt: '2026-09-05T00:00:08Z',
    }),
  )
  const records: Array<{ path: OwnedPath; value: JsonValue | string }> = [
    { path: verified.authority.subjectPath, value: verified.authority.subjectRecord },
  ]
  let actionCalls = 0
  let authority: unknown
  const store = {
    async publishReview(
      _authority: unknown,
      group: readonly { path: OwnedPath; bytes: Uint8Array }[],
    ) {
      for (const record of group) {
        const text = new TextDecoder().decode(record.bytes)
        records.push({
          path: record.path,
          value: record.path.endsWith('.json') ? (JSON.parse(text) as JsonValue) : text,
        })
      }
      return { path: group.at(-1)!.path, sha256: 'a'.repeat(64), bytes: 1 }
    },
    async createImmutable(path: OwnedPath, bytes: Uint8Array) {
      const text = new TextDecoder().decode(bytes)
      const existing = records.find(record => record.path === path)
      if (existing === undefined) records.push({ path, value: JSON.parse(text) as JsonValue })
      else if (canonicalJson(existing.value) !== text) throw new Error('immutable record conflict')
      return { path, sha256: 'a'.repeat(64), bytes: bytes.byteLength }
    },
    async readConfig() {
      return { canonicalBranch: 'feature/review' }
    },
    async readRecords() {
      return { records }
    },
    async createDecisionAction(value: DecisionAction, expected: unknown) {
      actionCalls += 1
      authority = expected
      const path = `decisions/actions/${value.actionId}.json` as OwnedPath
      if (!records.some(record => record.path === path)) records.push({ path, value })
      return { path, sha256: 'a'.repeat(64), bytes: 1 }
    },
  } as unknown as RepositoryStore
  await acceptReview(validated, store)
  const observations = records
    .filter(record => record.path.startsWith('decisions/observations/'))
    .map(record => record.value as DecisionObservation)
  const initial = foldDecisions(observations, [], 'feature/review')
  const current = observations.find(
    item => item.observationId === initial.lineages[0]!.currentObservationId,
  )!
  const changed = observations.find(item => item.observationId !== current.observationId)!
  return {
    store,
    records,
    current,
    changed,
    actionCalls: () => actionCalls,
    authority: () => authority,
  }
}

describe('decision action validation', () => {
  test('appends one action against the exact shared-fold state', async () => {
    const state = await fixture()
    const view = foldDecisions([state.current, state.changed], [], 'feature/review')
    const input = {
      schemaVersion: 1 as const,
      actionId: id('action', '1'),
      kind: 'supersede' as const,
      fromObservationId: state.current.observationId,
      toObservationId: state.changed.observationId,
      actor: { kind: 'human' as const },
      expectedStateFingerprint: view.stateFingerprint,
      note: 'Adopt the deliberate ownership change',
    }
    const result = await appendDecisionAction(
      state.store,
      input,
      () => new Date('2026-09-05T00:00:10Z'),
    )
    expect(result.actionId).toBe(id('action', '1'))
    expect(state.authority()).toMatchObject({ canonicalBranch: 'feature/review' })
    await expect(appendDecisionAction(state.store, input)).resolves.toMatchObject({
      actionId: id('action', '1'),
    })
    expect(state.actionCalls()).toBe(2)
  })

  test('rejects stale and semantically invalid requests before repository mutation', async () => {
    const state = await fixture()
    await expect(
      appendDecisionAction(state.store, {
        schemaVersion: 1,
        actionId: id('action', '2'),
        kind: 'confirm',
        targetObservationId: state.current.observationId,
        actor: { kind: 'human' },
        expectedStateFingerprint: '0'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(StaleDecisionActionError)

    const view = foldDecisions([state.current, state.changed], [], 'feature/review')
    await expect(
      appendDecisionAction(state.store, {
        schemaVersion: 1,
        actionId: id('action', '3'),
        kind: 'confirm',
        targetObservationId: state.current.observationId,
        actor: { kind: 'review', reviewId: id('review', '9') },
        expectedStateFingerprint: view.stateFingerprint,
      }),
    ).rejects.toThrow('review actors cannot apply decision actions')
    expect(state.actionCalls()).toBe(0)
  })

  test('rejects a stored observation that is not exactly derived from its review', async () => {
    const state = await fixture()
    const forged = state.records.find(record => record.path.startsWith('decisions/observations/'))!
    forged.value = { ...(forged.value as object), summary: 'forged' } as JsonValue
    await expect(
      appendDecisionAction(state.store, {
        schemaVersion: 1,
        actionId: id('action', '4'),
        kind: 'confirm',
        targetObservationId: state.current.observationId,
        actor: { kind: 'human' },
        expectedStateFingerprint: '0'.repeat(64),
      }),
    ).rejects.toThrow('not derived from its accepted review entry')
  })

  test('reports an authority race as a stale decision view', async () => {
    const state = await fixture()
    state.store.createDecisionAction = async value => {
      throw new DecisionAuthorityConflictError(
        `decisions/actions/${value.actionId}.json` as OwnedPath,
      )
    }
    const view = foldDecisions([state.current, state.changed], [], 'feature/review')
    await expect(
      appendDecisionAction(state.store, {
        schemaVersion: 1,
        actionId: id('action', '5'),
        kind: 'confirm',
        targetObservationId: state.current.observationId,
        actor: { kind: 'human' },
        expectedStateFingerprint: view.stateFingerprint,
      }),
    ).rejects.toBeInstanceOf(StaleDecisionActionError)
  })
})
