import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalJson, objectOwnedPath, type ReviewLedger } from '@factory/contract'
import { foldDecisions, loadVerifiedDecisionRecords } from '@factory/domain'
import {
  discoverRepositorySanitizer,
  initializeRepositoryStore,
  openRepositoryStore,
} from '@factory/repository'
import {
  openVerifiedReviewBundle,
  readVerifiedReviewBundle,
  ReviewAttemptCoordinator,
} from '@factory/reviewer'

import { sealReviewerRawAttempt } from '../../reviewer/src/attempt'
import { writerChoice, summarySubmissions } from '../../test-harness/src/choice-fixtures'
import {
  acceptReview,
  appendDecisionAction,
  validateReview,
  type DecisionActionInput,
} from '../src'

if (process.env.FACTORY_DOCKER_TEST !== '1') throw new Error('publication tests require Docker')
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const assets = join(import.meta.dir, '../../../specs/done/factory-v1/assets/review-plan')
  const report = JSON.parse(await readFile(join(assets, 'report.json'), 'utf8'))
  const bundle = await openVerifiedReviewBundle(
    join(assets, 'complete-bundle'),
    report.bundles.complete,
  )
  const verified = await readVerifiedReviewBundle(bundle)
  const root = await mkdtemp(join(tmpdir(), 'factory-safe-review-'))
  roots.push(root)
  await mkdir(join(root, '.git'))
  const store = await initializeRepositoryStore(
    root,
    {
      schemaVersion: 1,
      format: 'factory-repository',
      minimumReaderVersion: '0.1.0',
      repositoryId: verified.authority.repositoryId! as `repo_${string}`,
      createdAt: '2026-09-05T00:00:00Z',
    },
    {},
  )
  for (const reference of verified.authority.inventory) {
    const bytes = await readFile(join(verified.path, '.factory', objectOwnedPath(reference.sha256)))
    await store.putObject(
      (async function* () {
        yield bytes
      })(),
      reference,
    )
  }
  for (const record of verified.authority.records) {
    await store.createImmutable(
      record.path,
      await readFile(join(verified.path, '.factory', record.path)),
    )
  }
  return { root, store, bundle, verified }
}

test('review publication prepares prose before ledger and decision identity', async () => {
  const { root, store, bundle, verified } = await fixture()
  const secret = 'review-publication-secret'
  await writeFile(join(root, '.env'), `VALUE=${secret}\n`)
  const evidence = [{ object: verified.manifest.inventory[0]! }]
  const raw = sealReviewerRawAttempt({
    reviewId: 'review_00000000000000000000000009',
    bundleSha256: verified.sha256,
    submissions: Buffer.from(
      canonicalJson({
        kind: 'choice',
        choice: {
          ...writerChoice,
          headline: `Preserve reasoning ${secret}`,
          assertion: { owner: secret },
          evidence,
        },
      }) + summarySubmissions(evidence, `Reviewed ${secret}`),
    ),
    providerOutput: Buffer.from(`private ${secret}`),
    termination: 'completed',
    exitCode: 0,
    outputTruncated: false,
    reviewer: { settings: verified.manifest.plan.policies.reviewer },
    imageDigest: `sha256:${'b'.repeat(64)}`,
    providerCliVersion: `fixture ${secret}`,
    hostPlatform: `linux/${secret}`,
    startedAt: '2026-09-05T00:00:00Z',
    completedAt: '2026-09-05T00:00:01Z',
  })
  const prepared = await validateReview(bundle, raw, {
    sanitizer: await discoverRepositorySanitizer(root),
  })
  await acceptReview(prepared, store)
  const records = (await store.readRecords()).records
  const text = canonicalJson(records)
  expect(text).toContain('Preserve reasoning [REDACTED]')
  expect(text).not.toContain(secret)
  expect((await store.verify()).issues).toEqual([])
  if (process.env.FACTORY_WRITE_PUBLICATION_REPORT === '1') {
    await writeFile(
      '/output/review.json',
      canonicalJson({
        schemaVersion: 1,
        verdict: 'passed',
        invocation: 'bun run packages/review/test/docker.ts --report',
        records: records.filter(
          record => record.path.startsWith('reviews/') || record.path.startsWith('decisions/'),
        ),
      }),
    )
  }
})

test('prepared review publication survives env changes before its first public write', async () => {
  const { root, store, bundle, verified } = await fixture()
  const secret = 'frozen-review-secret'
  await writeFile(join(root, '.env'), `VALUE=${secret}\n`)
  const runtime = join(root, 'attempt-runtime')
  const coordinator = await ReviewAttemptCoordinator.open({ testRuntimeRoot: runtime })
  const choice = { settings: verified.manifest.plan.policies.reviewer }
  const imageDigest = `sha256:${'b'.repeat(64)}`
  const raw = await coordinator.run(
    bundle,
    choice,
    {
      async run(_bundle, reviewer, input) {
        return sealReviewerRawAttempt({
          reviewId: input.reviewId,
          bundleSha256: verified.sha256,
          reviewer,
          imageDigest,
          submissions: Buffer.from(
            summarySubmissions([{ object: verified.manifest.inventory[0]! }], `Useful ${secret}`),
          ),
          providerOutput: Buffer.from(secret),
          termination: 'completed',
          exitCode: 0,
          outputTruncated: false,
          providerCliVersion: 'fixture',
          hostPlatform: 'linux/arm64',
          startedAt: '2026-09-05T00:00:00Z',
          completedAt: '2026-09-05T00:00:01Z',
        })
      },
    },
    { imageReference: imageDigest, imageDigest, timeoutMs: 100 },
  )
  await validateReview(bundle, raw, { repositoryRoot: root, coordinator })
  await writeFile(join(root, '.env'), 'VALUE="unterminated\n')
  const reopened = await ReviewAttemptCoordinator.open({ testRuntimeRoot: runtime })
  const prepared = await validateReview(bundle, raw, {
    repositoryRoot: root,
    coordinator: reopened,
  })
  await acceptReview(prepared, store)
  expect(canonicalJson((await store.readRecords()).records)).toContain('Useful [REDACTED]')
  expect(canonicalJson((await store.readRecords()).records)).not.toContain(secret)
  expect((await store.verify()).issues).toEqual([])
})

test('review refuses a sensitive citation locator without rewriting its object authority', async () => {
  const { root, store, bundle, verified } = await fixture()
  const reference = verified.manifest.inventory[0]!
  const secret = 'sensitive-citation-locator'
  await writeFile(join(root, '.env'), `VALUE=${secret}\nSECRET_SHA=${reference.sha256}\n`)
  const raw = sealReviewerRawAttempt({
    reviewId: 'review_00000000000000000000000009',
    bundleSha256: verified.sha256,
    submissions: Buffer.from(
      canonicalJson({
        kind: 'choice',
        choice: {
          ...writerChoice,
          evidence: [{ object: reference, locator: secret }],
        },
      }) + summarySubmissions([{ object: reference }], 'Readable summary remains'),
    ),
    providerOutput: new Uint8Array(),
    termination: 'completed',
    exitCode: 0,
    outputTruncated: false,
    reviewer: { settings: verified.manifest.plan.policies.reviewer },
    imageDigest: `sha256:${'b'.repeat(64)}`,
    providerCliVersion: 'fixture',
    hostPlatform: 'linux/arm64',
    startedAt: '2026-09-05T00:00:00Z',
    completedAt: '2026-09-05T00:00:01Z',
  })
  const accepted = await acceptReview(
    await validateReview(bundle, raw, { sanitizer: await discoverRepositorySanitizer(root) }),
    store,
  )
  expect(accepted.disposition).toBe('partial')
  const records = (await store.readRecords()).records
  const ledger = records.find(record => record.path.endsWith('/ledger.json'))!
    .value as unknown as ReviewLedger
  expect(ledger.entries).toEqual([])
  expect(ledger.summary!.evidence).toEqual([{ object: reference }])
  expect(canonicalJson(records)).not.toContain(secret)
  expect((await store.verify()).issues).toEqual([])
})

test('human action retries reuse prepared prose after env rotation and reject a different request', async () => {
  const { root, store, bundle, verified } = await fixture()
  await store.updateConfig({ canonicalBranch: 'feature/review' })
  const secret = 'human-action-secret'
  await writeFile(join(root, '.env'), `VALUE=${secret}\n`)
  const evidence = [{ object: verified.manifest.inventory[0]! }]
  const raw = sealReviewerRawAttempt({
    reviewId: 'review_00000000000000000000000009',
    bundleSha256: verified.sha256,
    submissions: Buffer.from(
      canonicalJson({ kind: 'choice', choice: { ...writerChoice, evidence } }) +
        summarySubmissions(evidence),
    ),
    providerOutput: new Uint8Array(),
    termination: 'completed',
    exitCode: 0,
    outputTruncated: false,
    reviewer: { settings: verified.manifest.plan.policies.reviewer },
    imageDigest: `sha256:${'b'.repeat(64)}`,
    providerCliVersion: 'fixture',
    hostPlatform: 'linux/arm64',
    startedAt: '2026-09-05T00:00:00Z',
    completedAt: '2026-09-05T00:00:01Z',
  })
  await acceptReview(
    await validateReview(bundle, raw, { sanitizer: await discoverRepositorySanitizer(root) }),
    store,
  )
  const { observations, actions } = loadVerifiedDecisionRecords(await store.readRecords())
  const current = foldDecisions(observations, actions, 'feature/review')
  const input: DecisionActionInput = {
    schemaVersion: 1,
    actionId: 'action_00000000000000000000000009',
    kind: 'confirm',
    targetObservationId: observations[0]!.observationId,
    expectedStateFingerprint: current.stateFingerprint,
    actor: { kind: 'human', label: `Operator ${secret}` },
    note: `Accepted ${secret}`,
  }
  await store.prepareDecisionAction(input)
  await writeFile(join(root, '.env'), 'VALUE="unterminated\n')
  const reopened = await openRepositoryStore(root)
  const first = await appendDecisionAction(reopened, input)
  const saved = JSON.parse(Buffer.from(await store.readImmutable(first.path)).toString())
  expect(saved.note).toBe('Accepted [REDACTED]')
  expect(saved.actor.label).toBe('Operator [REDACTED]')
  await writeFile(join(root, '.env'), 'VALUE="unterminated\n')
  expect(await appendDecisionAction(store, input)).toEqual(first)
  await expect(
    appendDecisionAction(store, { ...input, note: 'different request' }),
  ).rejects.toThrow()
  expect((await store.verify()).issues).toEqual([])
  if (process.env.FACTORY_WRITE_PUBLICATION_REPORT === '1') {
    await writeFile(
      '/output/action.json',
      canonicalJson({
        schemaVersion: 1,
        verdict: 'passed',
        invocation: 'bun run packages/review/test/docker.ts --report',
        action: saved,
        replayAfterEnvRotation: 'same immutable reference',
        differentRequest: 'refused',
      }),
    )
  }
})

test('review preserves the structural null assertion of an explicit removal', async () => {
  const { root, store, bundle, verified } = await fixture()
  await writeFile(join(root, '.env'), 'PASSWORD=null\n')
  const evidence = [{ object: verified.manifest.inventory[0]! }]
  const raw = sealReviewerRawAttempt({
    reviewId: 'review_00000000000000000000000009',
    bundleSha256: verified.sha256,
    submissions: Buffer.from(
      canonicalJson({
        kind: 'choice',
        choice: { ...writerChoice, effect: 'remove', assertion: null, evidence },
      }) + summarySubmissions(evidence),
    ),
    providerOutput: new Uint8Array(),
    termination: 'completed',
    exitCode: 0,
    outputTruncated: false,
    reviewer: { settings: verified.manifest.plan.policies.reviewer },
    imageDigest: `sha256:${'b'.repeat(64)}`,
    providerCliVersion: 'fixture',
    hostPlatform: 'linux/arm64',
    startedAt: '2026-09-05T00:00:00Z',
    completedAt: '2026-09-05T00:00:01Z',
  })
  const result = await acceptReview(
    await validateReview(bundle, raw, { sanitizer: await discoverRepositorySanitizer(root) }),
    store,
  )
  expect(result.disposition).toBe('complete')
  const records = (await store.readRecords()).records
  const ledger = records.find(record => record.path.endsWith('/ledger.json'))!
    .value as unknown as ReviewLedger
  expect(ledger.entries[0]!.effect).toBe('remove')
  expect(ledger.entries[0]!.assertion).toBeNull()
  expect((await store.verify()).issues).toEqual([])
})

test('coverage admission refuses sensitive session keys but reuses an exact prepared action', async () => {
  const { root, store } = await fixture()
  const secret = 'coverage-session-secret'
  await writeFile(join(root, '.env'), `VALUE=${secret}\n`)
  const semantic = {
    schemaVersion: 1 as const,
    actionId: 'action_00000000000000000000000009' as const,
    reviewId: 'review_00000000000000000000000009' as const,
    acceptedLimitations: ['missing-transcript-range'] as const,
    acceptedTriggerIds: [],
    acceptedProblemIds: [],
    settledWatermarks: { [secret]: 1 },
  }
  const before = (await store.readRecords()).records
  await expect(store.createCoverageAction(semantic)).rejects.toThrow('unsupported-content')
  expect((await store.readRecords()).records).toEqual(before)
  const safe = { ...semantic, settledWatermarks: { session: 1 } }
  const first = await store.createCoverageAction(safe)
  await writeFile(join(root, '.env'), 'VALUE="unterminated\n')
  expect(await store.createCoverageAction(safe)).toEqual(first)
})
