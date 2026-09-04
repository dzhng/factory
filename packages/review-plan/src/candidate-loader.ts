import { verifyTurnEvidenceGraph } from '@factory/capture'
import {
  assertOwnedRecordPath,
  canonicalJson,
  makeOwnedPath,
  validatePublicRecord,
  type EvidenceEnvelope,
  type Limitation,
  type LimitationCode,
  type RecordId,
  type RepositoryObservation,
  type ReviewTrigger,
  type SessionIdentity,
  type TurnManifest,
} from '@factory/contract'

import type { PortableRecordReader } from './repository-reader'

export type EvidenceClassification =
  | 'included'
  | 'readable-partial'
  | 'unavailable'
  | 'corrupt'
  | 'unsafe'
  | 'excluded'
  | 'weak-context'

export type CandidateScopeProof =
  | { kind: 'workspace-store'; repositoryId: string }
  | { kind: 'prior-plan'; reviewId: RecordId }
  | { kind: 'diagnostic-only' }

export type CandidateEvidence = {
  identity: SessionIdentity
  trigger: ReviewTrigger
  turn: TurnManifest
  repositoryObservation?: RepositoryObservation
  availability?: Exclude<EvidenceClassification, 'included' | 'weak-context'>
  limitations?: readonly Limitation[]
  events: readonly EvidenceEnvelope[]
  transcript: readonly EvidenceEnvelope[]
}

export type CandidateProblem = {
  triggerId: RecordId
  scopeProof: CandidateScopeProof
  availability: 'unavailable' | 'corrupt' | 'unsafe' | 'excluded'
  limitations: readonly Limitation[]
} & (
  | { kind: 'range'; sessionKey: string; turnId: RecordId; evidenceWatermark: number }
  | { kind: 'opaque-problem' }
)

export type ReviewCandidate = CandidateEvidence | CandidateProblem

export type CandidateRecordDescriptor = {
  triggerId: RecordId
  scopeProof: CandidateScopeProof
}

function decodeRecord(path: string, bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value = JSON.parse(text) as unknown
  if (canonicalJson(value) !== text) throw new TypeError('record is not canonical JSON')
  assertOwnedRecordPath(path)
  validatePublicRecord(path, value)
  return value
}

function decodeJsonl(path: string, bytes: Uint8Array): EvidenceEnvelope[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.length === 0) return []
  if (!text.endsWith('\n')) throw new TypeError('JSONL record lacks final newline')
  return text
    .trimEnd()
    .split('\n')
    .map(line => {
      const value = JSON.parse(line) as EvidenceEnvelope
      if (canonicalJson(value) !== `${line}\n`)
        throw new TypeError('JSONL envelope is not canonical')
      assertOwnedRecordPath(path)
      validatePublicRecord(path, value)
      return value
    })
}

class ObjectClassificationError extends Error {
  constructor(
    readonly classification: CandidateProblem['availability'],
    readonly limitationCode: LimitationCode,
    message: string,
  ) {
    super(message)
  }
}

/** Materialize and classify one complete trigger graph without aborting readable siblings. */
export async function loadCandidateEvidence(
  reader: PortableRecordReader,
  descriptor: CandidateRecordDescriptor,
): Promise<ReviewCandidate> {
  const opaqueIdentity = {
    kind: 'opaque-problem' as const,
    triggerId: descriptor.triggerId,
    scopeProof: descriptor.scopeProof,
  }
  const triggerPath = makeOwnedPath('review-triggers', [`${descriptor.triggerId}.json`])
  const problem = (
    classification: CandidateProblem['availability'],
    detail: string,
    limitationCode?: LimitationCode,
    exact?: { sessionKey: string; turnId: RecordId; evidenceWatermark: number },
  ): CandidateProblem => ({
    ...(exact === undefined
      ? opaqueIdentity
      : {
          kind: 'range' as const,
          ...exact,
          triggerId: descriptor.triggerId,
          scopeProof: descriptor.scopeProof,
        }),
    availability: classification,
    limitations: [
      {
        code:
          limitationCode ?? (classification === 'corrupt' ? 'corrupt-input' : 'unverified-object'),
        detail,
      },
    ],
  })
  let trustedExact: { sessionKey: string; turnId: RecordId; evidenceWatermark: number } | undefined
  try {
    const triggerRead = await reader.read(triggerPath)
    if (triggerRead.kind !== 'readable')
      return problem(triggerRead.kind === 'unsafe' ? 'unsafe' : 'unavailable', triggerRead.detail)
    let trigger: ReviewTrigger
    try {
      trigger = decodeRecord(triggerPath, triggerRead.bytes) as ReviewTrigger
    } catch (error) {
      return problem('corrupt', error instanceof Error ? error.message : String(error))
    }
    const exact = {
      sessionKey: trigger.sessionKey,
      turnId: trigger.turnId,
      evidenceWatermark: trigger.evidenceWatermark,
    }
    trustedExact = exact
    const identityPath = makeOwnedPath('sessions', [
      trigger.provider,
      trigger.sessionKey,
      'identity.json',
    ])
    const turnRoot = [trigger.provider, trigger.sessionKey, 'turns', trigger.turnId]
    const turnPath = makeOwnedPath('sessions', [...turnRoot, 'manifest.json'])
    const eventsPath = makeOwnedPath('sessions', [...turnRoot, 'events.jsonl'])
    const transcriptPath = makeOwnedPath('sessions', [...turnRoot, 'transcript.jsonl'])
    const [identityRead, turnRead, eventsRead, transcriptRead] = await Promise.all([
      reader.read(identityPath),
      reader.read(turnPath),
      reader.read(eventsPath),
      reader.read(transcriptPath),
    ])
    if (identityRead.kind !== 'readable')
      return problem(
        identityRead.kind === 'unsafe' ? 'unsafe' : 'unavailable',
        identityRead.detail,
        undefined,
        exact,
      )
    if (turnRead.kind !== 'readable')
      return problem(
        turnRead.kind === 'unsafe' ? 'unsafe' : 'unavailable',
        turnRead.detail,
        undefined,
        exact,
      )
    if (eventsRead.kind !== 'readable')
      return problem(
        eventsRead.kind === 'unsafe' ? 'unsafe' : 'unavailable',
        eventsRead.detail,
        undefined,
        exact,
      )
    if (transcriptRead.kind !== 'readable')
      return problem(
        transcriptRead.kind === 'unsafe' ? 'unsafe' : 'unavailable',
        transcriptRead.detail,
        undefined,
        exact,
      )
    const identity = decodeRecord(identityPath, identityRead.bytes) as SessionIdentity
    const turn = decodeRecord(turnPath, turnRead.bytes) as TurnManifest
    const events = decodeJsonl(eventsPath, eventsRead.bytes)
    const transcript = decodeJsonl(transcriptPath, transcriptRead.bytes)
    if (
      identity.sessionKey !== trigger.sessionKey ||
      identity.provider !== trigger.provider ||
      turn.sessionKey !== trigger.sessionKey ||
      turn.turnId !== trigger.turnId ||
      turn.repositoryObservationId !== trigger.repositoryObservationId
    )
      return problem('corrupt', 'trigger, Turn, and descriptor identities do not join')
    let repositoryObservation: RepositoryObservation | undefined
    if (trigger.repositoryObservationId !== undefined) {
      const path = makeOwnedPath('repository-observations', [
        `${trigger.repositoryObservationId}.json`,
      ])
      const read = await reader.read(path)
      if (read.kind !== 'readable')
        return problem(
          read.kind === 'unsafe' ? 'unsafe' : 'unavailable',
          read.detail,
          undefined,
          exact,
        )
      repositoryObservation = decodeRecord(path, read.bytes) as RepositoryObservation
      if (repositoryObservation.observationId !== trigger.repositoryObservationId)
        return problem(
          'corrupt',
          'repository observation identity does not join the Turn',
          undefined,
          exact,
        )
    }
    if (
      repositoryObservation !== undefined &&
      identity.repositoryId !== repositoryObservation.repositoryId
    )
      return problem(
        'corrupt',
        'Session identity repository does not own the Turn observation',
        undefined,
        exact,
      )
    const candidate: CandidateEvidence = {
      identity,
      trigger,
      turn,
      repositoryObservation,
      events,
      transcript,
    }
    await verifyTurnEvidenceGraph(candidate, async reference => {
      const result = await reader.getObject(reference)
      if (result.kind !== 'readable')
        throw new ObjectClassificationError(
          result.kind === 'unsafe'
            ? 'unsafe'
            : result.kind === 'excluded-by-limit'
              ? 'excluded'
              : 'unavailable',
          result.kind === 'excluded-by-limit' ? 'excluded-by-limit' : 'unverified-object',
          result.detail,
        )
      return result.bytes
    })
    return candidate
  } catch (error) {
    if (error instanceof ObjectClassificationError)
      return problem(error.classification, error.message, error.limitationCode, trustedExact)
    return problem(
      'corrupt',
      error instanceof Error ? error.message : String(error),
      undefined,
      trustedExact,
    )
  }
}
