import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canonicalJson,
  encodeGitPath,
  makeOwnedPath,
  newRecordId,
  objectOwnedPath,
  reviewInputProblemId,
  reviewSubjectCoverageId,
  type ObjectRef,
  type RepositoryObservation,
  type ReviewTrigger,
  type SessionIdentity,
  type TurnManifest,
} from '@factory/contract'

import {
  buildBundle,
  loadCandidateEvidence,
  loadReviewHistory,
  loadReviewHistoryForTesting,
  loadReviewInputs,
  loadReviewInputsForTesting,
  openReviewRepositoryReader,
  planReview as planLoadedReview,
  planReviewForTesting as planReview,
  verifyBundle,
  type PortableRecordReader,
  type ReviewInputs,
  type ReviewRepositoryReader,
} from '../src'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const object = (bytes: Uint8Array, mediaType: string, role: string): ObjectRef => ({
  algorithm: 'sha256',
  sha256: digest(bytes),
  bytes: bytes.byteLength,
  mediaType,
  role,
})

function fixture(): { input: ReviewInputs; objects: Map<string, Uint8Array> } {
  const fileBytes = new TextEncoder().encode('review me\n')
  const file = object(fileBytes, 'application/octet-stream', 'workspace-file')
  const codeBytes = new TextEncoder().encode(
    canonicalJson({
      schemaVersion: 1,
      entries: [
        {
          path: encodeGitPath(new TextEncoder().encode('src/example.ts'), 'src/example.ts'),
          mode: '100644',
          kind: 'file',
          object: file,
        },
      ],
      limitations: [],
    }),
  )
  const code = object(
    codeBytes,
    'application/vnd.factory.code-manifest+json',
    'workspace-code-manifest',
  )
  const rawBytes = new TextEncoder().encode('{"provider":"codex"}\n')
  const raw = object(rawBytes, 'application/json', 'provider-event')
  const observedAt = '2026-09-05T00:00:00Z'
  const observationId = newRecordId('observation', 0, new Uint8Array(10))
  const turnId = newRecordId('turn', 0, new Uint8Array(10))
  const triggerId = newRecordId('trigger', 0, new Uint8Array(10))
  const observation: RepositoryObservation = {
    schemaVersion: 1,
    observationId,
    repositoryId: 'repo_test',
    observedAt,
    completedAt: observedAt,
    git: { head: '0123456789012345678901234567890123456789', branch: 'feature', detached: false },
    changedPaths: [],
    worktreeFingerprint: code.sha256,
    codeManifest: code,
    limitations: [],
    startState: '2'.repeat(64),
    endState: '2'.repeat(64),
  }
  const turn: TurnManifest = {
    schemaVersion: 1,
    turnId,
    sessionKey: 'session-a',
    nativeStopId: 'stop-a',
    capturedAt: observedAt,
    materializedAt: observedAt,
    eventRange: { first: 1, last: 1 },
    transcriptObservations: [],
    rawObjects: [raw],
    repositoryObservationId: observationId,
    codeManifest: code,
    limitations: [],
    captureAdapterVersion: 'capture-v1',
    formatVersion: 1,
    inventory: [code, raw, file].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
  }
  const trigger: ReviewTrigger = {
    schemaVersion: 1,
    triggerId,
    sessionKey: 'session-a',
    turnId,
    repositoryObservationId: observationId,
    evidenceWatermark: 1,
    provider: 'codex',
    createdAt: observedAt,
    materialization: 'complete',
    limitations: [],
  }
  const identity: SessionIdentity = {
    schemaVersion: 1,
    provider: 'codex',
    nativeSessionId: 'native-session-a',
    sessionKey: 'session-a',
    captureGeneration: 0,
    repositoryId: 'repo_test',
    firstObservedAt: observedAt,
  }
  return {
    input: {
      mode: 'incremental',
      subject: { kind: 'workspace', observation },
      candidates: [
        {
          identity,
          trigger,
          turn,
          repositoryObservation: observation,
          events: [{ sequence: 1, observedAt, raw }],
          transcript: [],
        },
      ],
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
    },
    objects: new Map([
      [file.sha256, fileBytes],
      [code.sha256, codeBytes],
      [raw.sha256, rawBytes],
    ]),
  }
}

describe('verified review bundles', () => {
  test('confined discovery ignores foreign Factory namespaces and inventories owned records', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'factory-review-reader-'))
    roots.push(parent)
    const factoryRoot = join(parent, '.factory')
    const triggerPath = makeOwnedPath('review-triggers', [
      'trigger_00000000000000000000000000.json',
    ])
    await mkdir(join(factoryRoot, 'review-triggers'), { recursive: true })
    await mkdir(join(factoryRoot, 'objects', 'sha256', 'aa'), { recursive: true })
    await mkdir(join(factoryRoot, 'future-owned-root'), { recursive: true })
    await writeFile(join(factoryRoot, triggerPath), '{}\n')
    await writeFile(join(factoryRoot, 'objects', 'sha256', 'aa', 'huge-foreign-cas'), 'ignored')
    await writeFile(join(factoryRoot, 'future-owned-root', 'foreign.json'), 'not review data')
    const reader = await openReviewRepositoryReader(factoryRoot)
    expect(await reader.inventory()).toEqual([triggerPath])
    expect((await reader.read(triggerPath)).kind).toBe('readable')
  })

  test('production loading enumerates triggers before Session filtering and bounds graph acquisition', async () => {
    const value = fixture()
    const candidate = value.input.candidates[0]!
    if (!('trigger' in candidate) || value.input.subject.kind !== 'workspace')
      throw new Error('expected readable workspace fixture')
    const root = await mkdtemp(join(tmpdir(), 'factory-review-acquisition-'))
    roots.push(root)
    const put = async (path: string, bytes: Uint8Array) => {
      const destination = join(root, path)
      await mkdir(join(destination, '..'), { recursive: true })
      await writeFile(destination, bytes)
    }
    const subjectPath = makeOwnedPath('repository-observations', [
      `${value.input.subject.observation.observationId}.json`,
    ])
    const turnRoot = `sessions/codex/${candidate.identity.sessionKey}/turns/${candidate.turn.turnId}`
    await put(subjectPath, new TextEncoder().encode(canonicalJson(value.input.subject.observation)))
    await put(
      makeOwnedPath('sessions', ['codex', candidate.identity.sessionKey, 'identity.json']),
      new TextEncoder().encode(canonicalJson(candidate.identity)),
    )
    await put(`${turnRoot}/manifest.json`, new TextEncoder().encode(canonicalJson(candidate.turn)))
    await put(
      `${turnRoot}/events.jsonl`,
      new TextEncoder().encode(candidate.events.map(canonicalJson).join('')),
    )
    await put(`${turnRoot}/transcript.jsonl`, new Uint8Array())
    await put(
      makeOwnedPath('review-triggers', [`${candidate.trigger.triggerId}.json`]),
      new TextEncoder().encode(canonicalJson(candidate.trigger)),
    )
    const deferredTrigger: ReviewTrigger = {
      ...candidate.trigger,
      triggerId: newRecordId('trigger', 20, new Uint8Array(10)),
      sessionKey: 'session-z',
      turnId: newRecordId('turn', 20, new Uint8Array(10)),
    }
    await put(
      makeOwnedPath('review-triggers', [`${deferredTrigger.triggerId}.json`]),
      new TextEncoder().encode(canonicalJson(deferredTrigger)),
    )
    const opaqueId = newRecordId('trigger', 21, new Uint8Array(10))
    await put(
      makeOwnedPath('review-triggers', [`${opaqueId}.json`]),
      new TextEncoder().encode('{}\n'),
    )
    for (const [hash, bytes] of value.objects) await put(objectOwnedPath(hash), bytes)
    const reader = await openReviewRepositoryReader(root)
    const history = await loadReviewHistory(reader)
    const bounded = planLoadedReview(
      await loadReviewInputs(reader, {
        mode: 'incremental',
        subjectPath,
        history,
        policies: value.input.policies,
        reviewLimits: { maxSessions: 1 },
      }),
    )
    expect(bounded.selections).toContainEqual(
      expect.objectContaining({
        triggerId: deferredTrigger.triggerId,
        coverageEffect: 'deferred-by-limit',
      }),
    )
    const named = planLoadedReview(
      await loadReviewInputs(reader, {
        mode: 'incremental',
        subjectPath,
        history,
        policies: value.input.policies,
        sessionKey: candidate.identity.sessionKey,
      }),
    )
    expect(named.selections.find(selection => selection.triggerId === opaqueId)).toEqual(
      expect.objectContaining({ coverageEffect: 'out-of-scope' }),
    )
    expect(named.limitations).toEqual([])
  })

  test('history limitation problems must name an object owned by the exact code manifest', async () => {
    const value = fixture()
    if (value.input.subject.kind !== 'workspace') throw new Error('expected workspace fixture')
    const initial = planReview({ ...value.input, candidates: [] })
    const reviewId = newRecordId('review', 2, new Uint8Array(10))
    const manifestPath = makeOwnedPath('reviews', ['workspace', reviewId, 'manifest.json'])
    const ledgerPath = makeOwnedPath('reviews', ['workspace', reviewId, 'ledger.json'])
    const subjectPath = makeOwnedPath('repository-observations', [
      `${value.input.subject.observation.observationId}.json`,
    ])
    const unrelatedBytes = new TextEncoder().encode('unrelated')
    const unrelated = object(unrelatedBytes, 'application/octet-stream', 'limitation-evidence')
    const limitation = {
      code: 'unverified-object' as const,
      detail: 'claimed historical code-manifest limitation',
      object: unrelated,
    }
    const payload = {
      kind: 'subject-object' as const,
      field: 'limitation' as const,
      object: unrelated,
      classification: 'unavailable' as const,
      limitation,
    }
    const problem = { ...payload, problemId: reviewInputProblemId(payload) }
    const manifest = {
      schemaVersion: 1 as const,
      reviewId,
      subject: {
        kind: 'workspace' as const,
        repositoryObservationId: value.input.subject.observation.observationId,
      },
      codeManifest: value.input.subject.observation.codeManifest,
      patches: [],
      sessionWatermarks: {},
      coverageTargetWatermarks: {},
      subjectFingerprint: initial.subjectFingerprint,
      subjectAttempt: {
        fingerprint: initial.subjectFingerprint,
        coverageId: reviewSubjectCoverageId(initial.subjectFingerprint, [limitation]),
        effect: 'reviewed-partial' as const,
        limitations: [limitation],
      },
      evidenceSelections: [],
      inputProblems: [problem],
      triggerIds: [],
      associationBatchIds: [],
      limitations: [limitation],
      reviewer: { provider: 'codex' as const },
      analyzerVersion: 'analyzer-v1',
      promptVersion: 'prompt-v1',
      policyVersion: 'policy-v1',
      formatVersion: 1 as const,
      bundleSha256: 'a'.repeat(64),
      containerImageDigest: `sha256:${'b'.repeat(64)}`,
      providerCliVersion: '1',
      hostPlatform: 'linux/arm64',
      startedAt: '2026-09-05T00:00:00Z',
      completedAt: '2026-09-05T00:00:01Z',
      disposition: 'partial' as const,
    }
    const records = new Map<string, Uint8Array>([
      [manifestPath, new TextEncoder().encode(canonicalJson(manifest))],
      [
        ledgerPath,
        new TextEncoder().encode(canonicalJson({ schemaVersion: 1, reviewId, entries: [] })),
      ],
      [subjectPath, new TextEncoder().encode(canonicalJson(value.input.subject.observation))],
    ])
    const reader: ReviewRepositoryReader = {
      inventory: async () => [...records.keys()].sort() as ReturnType<typeof makeOwnedPath>[],
      read: async path => {
        const bytes = records.get(path)
        return bytes === undefined ? { kind: 'missing', detail: path } : { kind: 'readable', bytes }
      },
      getObject: async reference => ({
        kind: 'readable',
        bytes: value.objects.get(reference.sha256) ?? unrelatedBytes,
      }),
    }
    await expect(
      loadReviewHistoryForTesting(reader, {
        reviews: [{ manifestPath }],
        coverageActionPaths: [],
      }),
    ).rejects.toThrow('not owned by its code manifest')

    const originalCode = JSON.parse(
      new TextDecoder().decode(
        value.objects.get(value.input.subject.observation.codeManifest!.sha256),
      ),
    )
    const historicalCodeBytes = new TextEncoder().encode(
      canonicalJson({ ...originalCode, limitations: [limitation] }),
    )
    const historicalCode = object(
      historicalCodeBytes,
      'application/vnd.factory.code-manifest+json',
      'workspace-code-manifest',
    )
    value.objects.set(historicalCode.sha256, historicalCodeBytes)
    const historicalObservation = {
      ...value.input.subject.observation,
      observationId: newRecordId('observation', 3, new Uint8Array(10)),
      codeManifest: historicalCode,
      worktreeFingerprint: historicalCode.sha256,
    }
    const historicalPlan = planReview({
      ...value.input,
      subject: { kind: 'workspace', observation: historicalObservation },
      candidates: [],
    })
    const historicalSubjectPath = makeOwnedPath('repository-observations', [
      `${historicalObservation.observationId}.json`,
    ])
    const validManifest = {
      ...manifest,
      subject: {
        kind: 'workspace' as const,
        repositoryObservationId: historicalObservation.observationId,
      },
      subjectFingerprint: historicalPlan.subjectFingerprint,
      codeManifest: historicalCode,
      subjectAttempt: {
        fingerprint: historicalPlan.subjectFingerprint,
        coverageId: reviewSubjectCoverageId(historicalPlan.subjectFingerprint, [limitation]),
        effect: 'reviewed-partial' as const,
        limitations: [limitation],
      },
    }
    records.set(manifestPath, new TextEncoder().encode(canonicalJson(validManifest)))
    records.set(
      historicalSubjectPath,
      new TextEncoder().encode(canonicalJson(historicalObservation)),
    )
    const historicalReader: ReviewRepositoryReader = {
      ...reader,
      getObject: async reference => {
        const bytes = value.objects.get(reference.sha256)
        return bytes === undefined
          ? { kind: 'missing', detail: reference.sha256 }
          : { kind: 'readable', bytes }
      },
    }
    const history = await loadReviewHistoryForTesting(historicalReader, {
      reviews: [{ manifestPath }],
      coverageActionPaths: [],
    })
    const loaded = await loadReviewInputsForTesting(historicalReader, {
      mode: 'incremental',
      subjectPath,
      history,
      policies: value.input.policies,
    })
    const plan = planLoadedReview(loaded)
    const parent = await mkdtemp(join(tmpdir(), 'factory-review-history-limitation-'))
    roots.push(parent)
    const built = await buildBundle(
      plan,
      { getObject: async reference => value.objects.get(reference.sha256)! },
      join(parent, 'bundle'),
    )
    expect((await verifyBundle(built.path, built.sha256)).valid).toBe(true)
  })

  test('plans and bundles from immutable loaded history without old subject object closure', async () => {
    const value = fixture()
    const initial = planReview({ ...value.input, candidates: [] })
    const reviewId = newRecordId('review', 1, new Uint8Array(10))
    const manifestPath = makeOwnedPath('reviews', ['workspace', reviewId, 'manifest.json'])
    const ledgerPath = makeOwnedPath('reviews', ['workspace', reviewId, 'ledger.json'])
    const subjectPath = makeOwnedPath('repository-observations', [
      `${value.input.subject.observation.observationId}.json`,
    ])
    const manifest = {
      schemaVersion: 1,
      reviewId,
      subject: {
        kind: 'workspace' as const,
        repositoryObservationId: value.input.subject.observation.observationId,
      },
      patches: [],
      sessionWatermarks: {},
      coverageTargetWatermarks: {},
      subjectFingerprint: initial.subjectFingerprint,
      subjectAttempt: initial.subjectAttempt,
      evidenceSelections: [],
      inputProblems: [],
      triggerIds: [],
      associationBatchIds: [],
      limitations: [],
      reviewer: { provider: 'codex' as const },
      analyzerVersion: 'analyzer-v1',
      promptVersion: 'prompt-v1',
      policyVersion: 'policy-v1',
      formatVersion: 1 as const,
      bundleSha256: 'a'.repeat(64),
      containerImageDigest: `sha256:${'b'.repeat(64)}`,
      providerCliVersion: '1',
      hostPlatform: 'linux/arm64',
      startedAt: '2026-09-05T00:00:00Z',
      completedAt: '2026-09-05T00:00:01Z',
      disposition: 'complete' as const,
    }
    const records = new Map<string, Uint8Array>([
      [manifestPath, new TextEncoder().encode(canonicalJson(manifest))],
      [
        ledgerPath,
        new TextEncoder().encode(canonicalJson({ schemaVersion: 1, reviewId, entries: [] })),
      ],
      [subjectPath, new TextEncoder().encode(canonicalJson(value.input.subject.observation))],
    ])
    const reader: ReviewRepositoryReader = {
      inventory: async () => [...records.keys()].sort() as ReturnType<typeof makeOwnedPath>[],
      read: async path => {
        const bytes = records.get(path)
        return bytes === undefined ? { kind: 'missing', detail: path } : { kind: 'readable', bytes }
      },
      getObject: async ref => ({ kind: 'readable', bytes: value.objects.get(ref.sha256)! }),
    }
    await expect(loadReviewHistory(reader)).rejects.toThrow('confined tree snapshot')
    const history = await loadReviewHistoryForTesting(reader, {
      reviews: [{ manifestPath }],
      coverageActionPaths: [],
    })
    await expect(
      loadReviewInputs(
        { ...reader },
        {
          mode: 'incremental',
          subjectPath,
          history,
          policies: value.input.policies,
        },
      ),
    ).rejects.toThrow('confined tree snapshot')
    const missingLeafReader: ReviewRepositoryReader = {
      ...reader,
      getObject: async ref =>
        ref.role === 'workspace-file'
          ? { kind: 'missing', detail: 'nested leaf missing' }
          : { kind: 'readable', bytes: value.objects.get(ref.sha256)! },
    }
    const missingLeafHistory = await loadReviewHistoryForTesting(missingLeafReader, {
      reviews: [{ manifestPath }],
      coverageActionPaths: [],
    })
    await expect(
      loadReviewInputsForTesting(missingLeafReader, {
        mode: 'incremental',
        subjectPath,
        history: missingLeafHistory,
        policies: value.input.policies,
      }),
    ).rejects.toThrow('foundational subject object')
    const loaded = await loadReviewInputsForTesting(reader, {
      mode: 'incremental',
      subjectPath,
      history,
      policies: { ...value.input.policies, policyVersion: 'policy-v2' },
    })
    records.set(subjectPath, new TextEncoder().encode('{}\n'))
    const plan = planLoadedReview(loaded)
    expect(() => planLoadedReview({} as Parameters<typeof planLoadedReview>[0])).toThrow(
      'loadReviewInputs',
    )
    expect(plan.status).toBe('ready')
    expect(plan.historySources.map(source => source.path)).toEqual(
      [subjectPath, ledgerPath, manifestPath].sort(),
    )
    const parent = await mkdtemp(join(tmpdir(), 'factory-review-history-bundle-'))
    roots.push(parent)
    const built = await buildBundle(
      plan,
      { getObject: async ref => value.objects.get(ref.sha256)! },
      join(parent, 'bundle'),
    )
    expect((await verifyBundle(built.path, built.sha256)).valid).toBe(true)
    const bundleManifestPath = join(built.path, 'bundle.json')
    const bundleManifest = JSON.parse(await readFile(bundleManifestPath, 'utf8'))
    bundleManifest.plan.historySources[0].kind = 'review-ledger'
    const forgedBytes = new TextEncoder().encode(canonicalJson(bundleManifest))
    await rm(bundleManifestPath)
    await writeFile(bundleManifestPath, forgedBytes)
    expect((await verifyBundle(built.path, digest(forgedBytes))).valid).toBe(false)
  })

  test('verifies an omitted object owned by a workspace code-manifest limitation', async () => {
    const value = fixture()
    if (value.input.subject.kind !== 'workspace') throw new Error('expected workspace fixture')
    const originalReference = value.input.subject.observation.codeManifest!
    const originalManifest = JSON.parse(
      new TextDecoder().decode(value.objects.get(originalReference.sha256)),
    )
    const unavailableBytes = new TextEncoder().encode('optional provenance')
    const unavailable = object(unavailableBytes, 'application/octet-stream', 'limitation-evidence')
    const manifestBytes = new TextEncoder().encode(
      canonicalJson({
        ...originalManifest,
        limitations: [
          {
            code: 'unverified-object',
            detail: 'optional code provenance unavailable',
            object: unavailable,
          },
        ],
      }),
    )
    const codeManifest = object(
      manifestBytes,
      'application/vnd.factory.code-manifest+json',
      'workspace-code-manifest',
    )
    value.objects.set(codeManifest.sha256, manifestBytes)
    const observation = {
      ...value.input.subject.observation,
      codeManifest,
      worktreeFingerprint: codeManifest.sha256,
    }
    const subjectPath = makeOwnedPath('repository-observations', [
      `${observation.observationId}.json`,
    ])
    const records = new Map<string, Uint8Array>([
      [subjectPath, new TextEncoder().encode(canonicalJson(observation))],
    ])
    const reader: ReviewRepositoryReader = {
      inventory: async () => [subjectPath],
      read: async path => {
        const bytes = records.get(path)
        return bytes === undefined ? { kind: 'missing', detail: path } : { kind: 'readable', bytes }
      },
      getObject: async reference =>
        canonicalJson(reference) === canonicalJson(unavailable)
          ? { kind: 'missing', detail: 'optional provenance was not captured' }
          : { kind: 'readable', bytes: value.objects.get(reference.sha256)! },
    }
    const history = await loadReviewHistoryForTesting(reader, {
      reviews: [],
      coverageActionPaths: [],
    })
    const loaded = await loadReviewInputsForTesting(reader, {
      mode: 'incremental',
      subjectPath,
      history,
      policies: value.input.policies,
    })
    const plan = planLoadedReview(loaded)
    expect(plan.inputProblems).toEqual([
      expect.objectContaining({ kind: 'subject-object', field: 'limitation', object: unavailable }),
    ])
    const parent = await mkdtemp(join(tmpdir(), 'factory-review-code-limitation-'))
    roots.push(parent)
    const built = await buildBundle(
      plan,
      { getObject: async reference => value.objects.get(reference.sha256)! },
      join(parent, 'bundle'),
    )
    expect((await verifyBundle(built.path, built.sha256)).valid).toBe(true)
  })

  test('copies portable records and transitive objects into a no-Git directory', async () => {
    const value = fixture()
    const parent = await mkdtemp(join(tmpdir(), 'factory-review-bundle-'))
    roots.push(parent)
    const destination = join(parent, 'bundle')
    const built = await buildBundle(
      planReview(value.input),
      { getObject: async ref => value.objects.get(ref.sha256)! },
      destination,
    )
    const verification = await verifyBundle(destination, built.sha256)
    expect(verification.valid).toBe(true)
    if (!verification.valid) return
    expect(verification.manifest.files.map(file => file.path)).toContain(
      `.factory/objects/sha256/${digest(new TextEncoder().encode('review me\n')).slice(0, 2)}/${digest(new TextEncoder().encode('review me\n')).slice(2)}`,
    )
    expect(verification.manifest.files.some(file => file.kind === 'record')).toBe(true)
  })

  test('rejects undeclared files and symbolic links', async () => {
    const value = fixture()
    const parent = await mkdtemp(join(tmpdir(), 'factory-review-bundle-'))
    roots.push(parent)
    const destination = join(parent, 'bundle')
    const built = await buildBundle(
      planReview(value.input),
      { getObject: async ref => value.objects.get(ref.sha256)! },
      destination,
    )
    await writeFile(join(destination, 'extra'), 'not declared')
    expect((await verifyBundle(destination, built.sha256)).valid).toBe(false)
    await rm(join(destination, 'extra'))
    await symlink('bundle.json', join(destination, 'link'))
    expect((await verifyBundle(destination, built.sha256)).valid).toBe(false)
  })

  test('rejects self-consistent reordered and contradictory manifests', async () => {
    const value = fixture()
    const parent = await mkdtemp(join(tmpdir(), 'factory-review-bundle-'))
    roots.push(parent)
    const destination = join(parent, 'bundle')
    const built = await buildBundle(
      planReview(value.input),
      { getObject: async ref => value.objects.get(ref.sha256)! },
      destination,
    )
    const manifestPath = join(destination, 'bundle.json')
    const original = JSON.parse(await readFile(manifestPath, 'utf8'))
    const verifyTamper = async (manifest: typeof original) => {
      await rm(manifestPath)
      const bytes = new TextEncoder().encode(canonicalJson(manifest))
      await writeFile(manifestPath, bytes)
      return verifyBundle(destination, digest(bytes))
    }
    const reordered = structuredClone(original)
    reordered.files.reverse()
    expect((await verifyTamper(reordered)).valid).toBe(false)
    const contradictory = structuredClone(original)
    contradictory.plan.selections[0].selectedForReview = false
    expect((await verifyTamper(contradictory)).valid).toBe(false)
    const bogusKind = structuredClone(original)
    bogusKind.files[0].kind = 'mystery'
    expect((await verifyTamper(bogusKind)).valid).toBe(false)
    const extraKey = structuredClone(original)
    extraKey.files[0].surprise = true
    expect((await verifyTamper(extraKey)).valid).toBe(false)
    const arbitraryPath = structuredClone(original)
    arbitraryPath.files[0].path = '../outside'
    expect((await verifyTamper(arbitraryPath)).valid).toBe(false)
    const falseNoop = structuredClone(original)
    falseNoop.plan.status = 'already-reviewed'
    expect((await verifyTamper(falseNoop)).valid).toBe(false)
    const wrongSubjectReview = structuredClone(original)
    wrongSubjectReview.plan.subjectReview = 'full-current-pr-diff'
    expect((await verifyTamper(wrongSubjectReview)).valid).toBe(false)
    const wrongReplay = structuredClone(original)
    wrongReplay.plan.replayCoveredEvidence = true
    expect((await verifyTamper(wrongReplay)).valid).toBe(false)
    const wrongRange = structuredClone(original)
    wrongRange.plan.sessions[0].toInclusive += 1
    expect((await verifyTamper(wrongRange)).valid).toBe(false)
    const duplicateRangeTrigger = structuredClone(original)
    duplicateRangeTrigger.plan.sessions[0].triggerIds.push(
      duplicateRangeTrigger.plan.sessions[0].triggerIds[0],
    )
    expect((await verifyTamper(duplicateRangeTrigger)).valid).toBe(false)
    await verifyTamper(original)
    expect((await verifyBundle(destination, built.sha256)).valid).toBe(true)
  })

  test('loader preserves missing, unsafe, corrupt, and limit classifications', async () => {
    const value = fixture()
    const candidate = value.input.candidates[0]!
    if (!('trigger' in candidate)) throw new Error('fixture candidate is not readable')
    const descriptor = {
      triggerId: candidate.trigger.triggerId,
      scopeProof: { kind: 'workspace-store' as const, repositoryId: 'repo_test' },
    }
    const identityPath = makeOwnedPath('sessions', ['codex', 'session-a', 'identity.json'])
    const triggerPath = makeOwnedPath('review-triggers', [`${candidate.trigger.triggerId}.json`])
    const turnRoot = ['codex', 'session-a', 'turns', candidate.turn.turnId]
    const turnPath = makeOwnedPath('sessions', [...turnRoot, 'manifest.json'])
    const eventsPath = makeOwnedPath('sessions', [...turnRoot, 'events.jsonl'])
    const transcriptPath = makeOwnedPath('sessions', [...turnRoot, 'transcript.jsonl'])
    const observationPath = makeOwnedPath('repository-observations', [
      `${candidate.repositoryObservation!.observationId}.json`,
    ])
    const records = new Map<string, Uint8Array>([
      [identityPath, new TextEncoder().encode(canonicalJson(candidate.identity))],
      [triggerPath, new TextEncoder().encode(canonicalJson(candidate.trigger))],
      [turnPath, new TextEncoder().encode(canonicalJson(candidate.turn))],
      [
        eventsPath,
        new TextEncoder().encode(candidate.events.map(event => canonicalJson(event)).join('')),
      ],
      [transcriptPath, new Uint8Array()],
      [observationPath, new TextEncoder().encode(canonicalJson(candidate.repositoryObservation))],
    ])
    const reader = (
      recordOverride?: Map<string, Awaited<ReturnType<PortableRecordReader['read']>>>,
      objectKind: 'readable' | 'missing' | 'unsafe' | 'excluded-by-limit' = 'readable',
    ): PortableRecordReader => ({
      read: async path =>
        recordOverride?.get(path) ?? {
          kind: 'readable',
          bytes: records.get(path)!,
        },
      getObject: async ref =>
        objectKind === 'readable'
          ? { kind: 'readable', bytes: value.objects.get(ref.sha256)! }
          : { kind: objectKind, detail: objectKind },
    })
    expect('trigger' in (await loadCandidateEvidence(reader(), descriptor))).toBe(true)
    expect(
      (
        await loadCandidateEvidence(
          reader(new Map([[identityPath, { kind: 'missing', detail: 'gone' }]])),
          descriptor,
        )
      ).availability,
    ).toBe('unavailable')
    expect(
      (
        await loadCandidateEvidence(
          reader(new Map([[turnPath, { kind: 'unsafe', detail: 'link' }]])),
          descriptor,
        )
      ).availability,
    ).toBe('unsafe')
    expect(await loadCandidateEvidence(reader(undefined, 'missing'), descriptor)).toEqual(
      expect.objectContaining({ availability: 'unavailable' }),
    )
    expect(await loadCandidateEvidence(reader(undefined, 'unsafe'), descriptor)).toEqual(
      expect.objectContaining({ availability: 'unsafe' }),
    )
    expect(await loadCandidateEvidence(reader(undefined, 'excluded-by-limit'), descriptor)).toEqual(
      expect.objectContaining({
        availability: 'excluded',
        limitations: [expect.objectContaining({ code: 'excluded-by-limit' })],
      }),
    )
    const corruptReader = reader()
    corruptReader.getObject = async () => ({ kind: 'readable', bytes: new Uint8Array([9]) })
    expect(await loadCandidateEvidence(corruptReader, descriptor)).toEqual(
      expect.objectContaining({ availability: 'corrupt' }),
    )
  })
})
