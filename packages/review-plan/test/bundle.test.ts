import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canonicalJson,
  encodeGitPath,
  makeOwnedPath,
  newRecordId,
  type ObjectRef,
  type RepositoryObservation,
  type ReviewTrigger,
  type SessionIdentity,
  type TurnManifest,
} from '@factory/contract'

import {
  buildBundle,
  loadCandidateEvidence,
  planReview,
  verifyBundle,
  type PortableRecordReader,
  type ReviewInputs,
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
    inventory: [code, raw],
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
