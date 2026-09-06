import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { canonicalJson, type ObjectRef, type ReviewManifest } from '@factory/contract'
import type { RepositoryStore } from '@factory/repository'
import { openVerifiedReviewBundle, readVerifiedReviewBundle } from '@factory/reviewer'
import { createSanitizer } from '@factory/sanitization'

import { sealReviewerRawAttempt } from '../../reviewer/src/attempt'
import {
  writerChoice,
  summarySubmissions,
  checkpointChoices,
} from '../../test-harness/src/choice-fixtures'
import { acceptReview, validateReview, type RawAttempt } from '../src'

const reviewId = 'review_00000000000000000000000009' as const
const at = '2026-09-05T00:00:00Z'

async function fixture() {
  const root = join(import.meta.dir, '../../../specs/done/factory-v1/assets/review-plan')
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as {
    bundles: { complete: string; partial: string }
  }
  const path = join(root, 'complete-bundle')
  const bundle = await openVerifiedReviewBundle(path, report.bundles.complete)
  const manifest = JSON.parse(await readFile(join(path, 'bundle.json'), 'utf8')) as {
    inventory: ObjectRef[]
    plan: { policies: { reviewer: { provider: 'codex'; model: string; effort: string } } }
  }
  return { bundle, manifest, sha256: report.bundles.complete }
}

async function partialFixture() {
  const root = join(import.meta.dir, '../../../specs/done/factory-v1/assets/review-plan')
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as {
    bundles: { partial: string }
  }
  const path = join(root, 'partial-bundle')
  const bundle = await openVerifiedReviewBundle(path, report.bundles.partial)
  const manifest = JSON.parse(await readFile(join(path, 'bundle.json'), 'utf8')) as {
    inventory: ObjectRef[]
    plan: { policies: { reviewer: { provider: 'codex'; model: string; effort: string } } }
  }
  return { bundle, manifest, sha256: report.bundles.partial }
}

async function incrementalFixture() {
  const root = join(import.meta.dir, '../../../specs/done/factory-v1/assets/review-plan')
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as {
    bundles: { pullRequestIncremental: string }
  }
  const path = join(root, 'pr-incremental-bundle')
  const bundle = await openVerifiedReviewBundle(path, report.bundles.pullRequestIncremental)
  const manifest = JSON.parse(await readFile(join(path, 'bundle.json'), 'utf8')) as {
    inventory: ObjectRef[]
    plan: {
      priorLedger: { path: string; object: unknown }
      policies: { reviewer: { provider: 'codex'; model: string; effort: string } }
    }
  }
  return { bundle, manifest, sha256: report.bundles.pullRequestIncremental }
}

async function authorizedStore(
  bundle: Awaited<ReturnType<typeof openVerifiedReviewBundle>>,
  methods: Record<string, unknown>,
): Promise<RepositoryStore> {
  const verified = await readVerifiedReviewBundle(bundle)
  const store = {
    async preparePublication() {
      return { prepareRecord: (path: string, bytes: Uint8Array) => ({ path, bytes }) }
    },
    manifest: { repositoryId: verified.authority.repositoryId ?? 'repo_review_lab' },
    async readImmutable() {
      return new TextEncoder().encode(canonicalJson(verified.authority.subjectRecord))
    },
    async getObject() {
      return new Uint8Array()
    },
    ...methods,
  } as Record<string, unknown> & { manifest: { repositoryId: string } }
  store.createImmutable = async (record: { path: string; bytes: Uint8Array }) =>
    await (methods.createImmutable as (path: string, bytes: Uint8Array) => Promise<unknown>)(
      record.path,
      record.bytes,
    )
  store.publishReview = async (
    authority: { repositoryId?: string },
    records: readonly { path: string; bytes: Uint8Array }[],
    commitPath: string,
  ) => {
    if (
      authority.repositoryId !== undefined &&
      authority.repositoryId !== store.manifest.repositoryId
    )
      throw new TypeError('review bundle belongs to a different repository')
    return await (
      methods.publishImmutableGroup as (
        records: readonly { path: string; bytes: Uint8Array }[],
        commitPath: string,
      ) => Promise<unknown>
    )(records, commitPath)
  }
  return store as unknown as RepositoryStore
}

describe('immutable review acceptance', () => {
  test('accepts standalone choice audits with all three verdicts and exact citations', async () => {
    const { bundle, manifest, sha256 } = await fixture()
    const evidence = [{ object: manifest.inventory[0]! }]
    const choices = checkpointChoices(evidence)
    const response = new TextEncoder().encode(
      [
        ...choices.map(choice => ({ kind: 'choice', choice })),
        {
          kind: 'audit-summary',
          summary: { reviewed: 'Inspected implementation history and the prior ledger.', evidence },
        },
        { kind: 'finish' },
      ]
        .map(value => canonicalJson(value))
        .join(''),
    )
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        providerOutput: new TextEncoder().encode('private diagnostic must not be published'),
        reviewId,
        bundleSha256: sha256,
        submissions: response,
        termination: 'completed',
        exitCode: 0,
        outputTruncated: false,
        reviewer: { settings: manifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fixture',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
      { sanitizer: createSanitizer([]) },
    )
    let ledger: { entries: typeof choices; summary: { reviewed: string } } | undefined
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        expect(
          records.some(item =>
            new TextDecoder()
              .decode(item.bytes)
              .includes('private diagnostic must not be published'),
          ),
        ).toBeFalse()
        const record = records.find(item => item.path.endsWith('ledger.json'))
        if (record) ledger = JSON.parse(new TextDecoder().decode(record.bytes))
        return { path: '', sha256: '', bytes: 0 }
      },
      async createImmutable() {
        return { path: '', sha256: '', bytes: 0 }
      },
    })
    expect(await acceptReview(validated, store)).toMatchObject({
      disposition: 'complete',
      executionFailed: false,
    })
    expect(ledger!.entries.map(entry => entry.verdict)).toEqual(['needs-user', 'unsound', 'sound'])
    expect(ledger!.entries).toEqual(
      expect.arrayContaining(choices.map(choice => expect.objectContaining(choice))),
    )
    expect(ledger!.summary.reviewed).toBe('Inspected implementation history and the prior ledger.')
  })
  test('rejects forged attempts and a target repository outside the bundle authority', async () => {
    const { bundle, manifest: bundleManifest, sha256 } = await fixture()
    await expect(
      validateReview(bundle, {} as RawAttempt, { sanitizer: createSanitizer([]) }),
    ).rejects.toThrow('attempt capability is not verified')
    const citation = bundleManifest.inventory[0]!
    const raw = sealReviewerRawAttempt({
      providerOutput: new Uint8Array(),
      reviewId,
      bundleSha256: sha256,
      submissions: new TextEncoder().encode(
        summarySubmissions([{ object: citation }], 'Review completed'),
      ),
      termination: 'completed',
      exitCode: 0,
      outputTruncated: false,
      reviewer: { settings: bundleManifest.plan.policies.reviewer },
      imageDigest: `sha256:${'b'.repeat(64)}`,
      providerCliVersion: 'fake-1',
      hostPlatform: 'linux/arm64',
      startedAt: at,
      completedAt: at,
    })
    const validated = await validateReview(bundle, raw, { sanitizer: createSanitizer([]) })
    const { bundle: otherBundle } = await partialFixture()
    await expect(
      validateReview(otherBundle, raw, { sanitizer: createSanitizer([]) }),
    ).rejects.toThrow('different verified bundle')
    const store = await authorizedStore(bundle, {
      manifest: { repositoryId: 'repo_elsewhere' },
      async publishImmutableGroup() {
        throw new Error('must not publish')
      },
    })
    await expect(acceptReview(validated, store)).rejects.toThrow('different repository')
  })

  test('derives a complete manifest and ledger from cited semantic output', async () => {
    const { bundle, manifest: bundleManifest, sha256 } = await fixture()
    const citation = bundleManifest.inventory[0]!
    const response = new TextEncoder().encode(
      canonicalJson({
        kind: 'choice',
        choice: {
          ...writerChoice,
          choiceKey: 'repository.single-writer',
          evidence: [{ object: citation }],
        },
      }) + summarySubmissions([{ object: citation }], 'Review completed'),
    )
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        providerOutput: new Uint8Array(),
        reviewId,
        bundleSha256: sha256,
        submissions: response,
        termination: 'completed',
        exitCode: 0,
        outputTruncated: false,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
      { sanitizer: createSanitizer([]) },
    )
    let published:
      | { records: readonly { path: string; bytes: Uint8Array }[]; commitPath: string }
      | undefined
    const decisionRecords: { path: string; bytes: Uint8Array }[] = []
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup(
        records: readonly { path: string; bytes: Uint8Array }[],
        commitPath: string,
      ) {
        published = { records, commitPath }
        return { path: commitPath, sha256: '', bytes: 0 }
      },
      async createImmutable(path: string, bytes: Uint8Array) {
        decisionRecords.push({ path, bytes })
        return { path, sha256: '', bytes: bytes.byteLength }
      },
    })
    const accepted = await acceptReview(validated, store)
    const manifestRecord = published!.records.find(record => record.path.endsWith('manifest.json'))!
    const review = JSON.parse(new TextDecoder().decode(manifestRecord.bytes)) as ReviewManifest

    expect(accepted).toMatchObject({ disposition: 'complete', executionFailed: false })
    expect(published!.commitPath).toBe(manifestRecord.path)
    expect(published!.records.map(record => record.path)).toEqual([
      `reviews/workspace/${reviewId}/submissions.jsonl`,
      `reviews/workspace/${reviewId}/ledger.json`,
      `reviews/workspace/${reviewId}/manifest.json`,
    ])
    expect(review.reviewer).toEqual(bundleManifest.plan.policies.reviewer)
    expect(review.bundleSha256).toHaveLength(64)
    expect(canonicalJson(review.limitations)).toBe(canonicalJson([]))
    expect(decisionRecords).toHaveLength(1)
    expect(decisionRecords[0]!.path).toMatch(/^decisions\/observations\/decision_.*\.json$/)
    expect(JSON.parse(new TextDecoder().decode(decisionRecords[0]!.bytes))).toMatchObject({
      choiceKey: 'repository.single-writer',
      effect: 'assert',
      source: { kind: 'workspace', exactSnapshot: true },
    })
  })

  test('carries prior ledger bytes into CAS publication authority', async () => {
    const { bundle, manifest: bundleManifest, sha256 } = await incrementalFixture()
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        providerOutput: new Uint8Array(),
        reviewId,
        bundleSha256: sha256,
        submissions: new TextEncoder().encode(
          summarySubmissions(
            [{ object: bundleManifest.inventory[0]! }],
            'Incremental review completed',
          ),
        ),
        termination: 'completed',
        exitCode: 0,
        outputTruncated: false,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
      { sanitizer: createSanitizer([]) },
    )
    let authority: { recordObjects: readonly { path: string; object: unknown }[] } | undefined
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup() {
        return { path: '', sha256: '', bytes: 0 }
      },
    })
    const publishReview = store.publishReview.bind(store)
    store.publishReview = async (value, records, commitPath) => {
      authority = value
      return await publishReview(value, records, commitPath)
    }
    await acceptReview(validated, store)
    expect(authority!.recordObjects).toEqual([
      {
        path: bundleManifest.plan.priorLedger.path,
        object: bundleManifest.plan.priorLedger.object,
      },
    ])
  })

  test('salvages a valid prefix as partial and reports execution failure separately', async () => {
    const { bundle, manifest: bundleManifest, sha256 } = await fixture()
    const response = new TextEncoder().encode(
      summarySubmissions([{ object: bundleManifest.inventory[0]! }], 'Useful prefix') + '{"bad"',
    )
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        providerOutput: new Uint8Array(),
        reviewId,
        bundleSha256: sha256,
        submissions: response,
        termination: 'timed-out',
        exitCode: null,
        outputTruncated: true,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
      { sanitizer: createSanitizer([]) },
    )
    let manifest: ReviewManifest | undefined
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        const record = records.find(item => item.path.endsWith('manifest.json'))!
        manifest = JSON.parse(new TextDecoder().decode(record.bytes)) as ReviewManifest
        return { path: record.path, sha256: '', bytes: 0 }
      },
    })
    const accepted = await acceptReview(validated, store)

    expect(accepted).toMatchObject({ disposition: 'partial', executionFailed: true })
    expect(manifest!.subjectAttempt.effect).toBe('reviewed-partial')
    expect(manifest!.limitations).toContainEqual({
      code: 'invalid-review-output',
      detail: 'Reviewer execution or semantic output was incomplete',
    })
  })

  test('keeps valid subject coverage when only selected session input is partial', async () => {
    const { bundle, manifest: bundleManifest, sha256 } = await partialFixture()
    const response = new TextEncoder().encode(
      summarySubmissions([{ object: bundleManifest.inventory[0]! }], 'Reviewed available evidence'),
    )
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        providerOutput: new Uint8Array(),
        reviewId,
        bundleSha256: sha256,
        submissions: response,
        termination: 'completed',
        exitCode: 0,
        outputTruncated: false,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
      { sanitizer: createSanitizer([]) },
    )
    let manifest: ReviewManifest | undefined
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        const record = records.find(item => item.path.endsWith('manifest.json'))!
        manifest = JSON.parse(new TextDecoder().decode(record.bytes)) as ReviewManifest
        return { path: record.path, sha256: '', bytes: 0 }
      },
    })
    await acceptReview(validated, store)

    expect(manifest!.disposition).toBe('partial')
    expect(manifest!.subjectAttempt.effect).toBe('current-included')
  })

  test('publishes only the bounded valid UTF-8 response prefix', async () => {
    const { bundle, manifest: bundleManifest, sha256 } = await fixture()
    const prefix = new TextEncoder().encode(
      summarySubmissions([{ object: bundleManifest.inventory[0]! }], 'Useful prefix'),
    )
    const response = new Uint8Array(2 * 1024 * 1024)
    response.set(prefix)
    response[prefix.byteLength] = 0xff
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        providerOutput: new Uint8Array(),
        reviewId,
        bundleSha256: sha256,
        submissions: response,
        termination: 'completed',
        exitCode: 0,
        outputTruncated: false,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
      { sanitizer: createSanitizer([]) },
    )
    let publishedResponse: Uint8Array | undefined
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        publishedResponse = records.find(item => item.path.endsWith('submissions.jsonl'))!.bytes
        const record = records.find(item => item.path.endsWith('manifest.json'))!
        return { path: record.path, sha256: '', bytes: 0 }
      },
    })
    const accepted = await acceptReview(validated, store)

    expect(publishedResponse).toEqual(prefix)
    expect(publishedResponse!.byteLength).toBeLessThanOrEqual(1024 * 1024)
    expect(accepted).toMatchObject({ disposition: 'partial', executionFailed: true })
  })

  test('persists closed sanitized failures when no semantic entry is valid', async () => {
    const { bundle, manifest: bundleManifest, sha256 } = await fixture()
    const invalidCitation = canonicalJson({
      kind: 'audit-summary',
      summary: {
        reviewed: 'Unsupported result',
        evidence: [
          {
            object: {
              ...bundleManifest.inventory[0],
              role: 'forged-role',
            },
          },
        ],
      },
    })
    for (const scenario of [
      { termination: 'authentication-unavailable' as const, submissions: '' },
      { termination: 'docker-unavailable' as const, submissions: '' },
      { termination: 'crashed' as const, submissions: '' },
      { termination: 'completed' as const, submissions: '{malformed' },
      { termination: 'completed' as const, submissions: invalidCitation },
    ]) {
      const validated = await validateReview(
        bundle,
        sealReviewerRawAttempt({
          providerOutput: new Uint8Array(),
          reviewId,
          bundleSha256: sha256,
          submissions: new TextEncoder().encode(scenario.submissions),
          termination: scenario.termination,
          exitCode: scenario.termination === 'completed' ? 0 : null,
          outputTruncated: false,
          reviewer: { settings: bundleManifest.plan.policies.reviewer },
          imageDigest: `sha256:${'b'.repeat(64)}`,
          providerCliVersion: scenario.termination === 'completed' ? 'fake-1' : null,
          hostPlatform: 'linux/arm64',
          startedAt: at,
          completedAt: at,
        }),
        { sanitizer: createSanitizer([]) },
      )
      let paths: string[] = []
      let manifest: ReviewManifest | undefined
      const store = await authorizedStore(bundle, {
        async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
          paths = records.map(record => record.path)
          const record = records.find(item => item.path.endsWith('manifest.json'))!
          manifest = JSON.parse(new TextDecoder().decode(record.bytes)) as ReviewManifest
          return { path: record.path, sha256: '', bytes: 0 }
        },
      })
      const accepted = await acceptReview(validated, store)
      expect(accepted).toMatchObject({ disposition: 'failed', executionFailed: true })
      expect(paths.some(path => path.endsWith('ledger.json'))).toBe(false)
      expect(manifest!.failureReason).toMatch(
        /^(authentication-unavailable|docker-unavailable|reviewer-crashed|invalid-review-output)$/,
      )
    }
  })

  test('salvages a cited cancellation prefix as execution-partial', async () => {
    const { bundle, manifest: bundleManifest, sha256 } = await fixture()
    const validated = await validateReview(
      bundle,
      sealReviewerRawAttempt({
        providerOutput: new Uint8Array(),
        reviewId,
        bundleSha256: sha256,
        submissions: new TextEncoder().encode(
          summarySubmissions(
            [{ object: bundleManifest.inventory[0]! }],
            'Useful before cancellation',
          ),
        ),
        termination: 'cancelled',
        exitCode: null,
        outputTruncated: false,
        reviewer: { settings: bundleManifest.plan.policies.reviewer },
        imageDigest: `sha256:${'b'.repeat(64)}`,
        providerCliVersion: 'fake-1',
        hostPlatform: 'linux/arm64',
        startedAt: at,
        completedAt: at,
      }),
      { sanitizer: createSanitizer([]) },
    )
    const store = await authorizedStore(bundle, {
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        const record = records.find(item => item.path.endsWith('manifest.json'))!
        return { path: record.path, sha256: '', bytes: 0 }
      },
    })
    await expect(acceptReview(validated, store)).resolves.toMatchObject({
      disposition: 'partial',
      executionFailed: true,
    })
  })
})
