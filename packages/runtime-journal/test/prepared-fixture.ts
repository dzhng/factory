import { createHash } from 'node:crypto'

import {
  canonicalJson,
  makeOwnedPath,
  newRecordId,
  type OwnedPath,
  type TurnManifest,
} from '@factory/contract'
import { initializeRepositoryStore } from '@factory/repository'

export function turnFixture(
  provider: 'codex' | 'claude',
  session: string,
  stop: string,
  content: string,
) {
  const turnId = newRecordId(
    'turn',
    Date.parse('2026-09-04T00:00:00Z'),
    createHash('sha256').update(stop).digest().subarray(0, 10),
  )
  const path = makeOwnedPath('sessions', [provider, session, 'turns', turnId, 'manifest.json'])
  const value: TurnManifest = {
    schemaVersion: 1,
    turnId,
    sessionKey: session,
    nativeStopId: stop,
    capturedAt: '2026-09-04T00:00:00Z',
    materializedAt: '2026-09-04T00:00:00Z',
    eventRange: { first: 0, last: 0 },
    transcriptObservations: [],
    evidenceObjects: [],
    limitations: [{ code: 'missing-transcript-range', detail: content }],
    captureAdapterVersion: 'fixture',
    formatVersion: 1,
    inventory: [],
  }
  return { path, bytes: new TextEncoder().encode(canonicalJson(value)) }
}

export async function prepareFixtureRecord(root: string, path: OwnedPath, bytes: Uint8Array) {
  const store = await initializeRepositoryStore(
    root,
    {
      schemaVersion: 1,
      format: 'factory-repository',
      minimumReaderVersion: '0.1.0',
      repositoryId: 'repo_fixture',
      createdAt: '2026-09-04T00:00:00Z',
    },
    { schemaVersion: 1 },
    { runtimeRoot: root },
  )
  return (await store.preparePublication()).prepareRecord(path, bytes)
}
