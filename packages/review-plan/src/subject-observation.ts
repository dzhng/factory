import {
  canonicalJson,
  newRecordId,
  type AssociationBatch,
  type AvailablePullRequestObservation,
  type GithubRepositoryMappingObservation,
  type OwnedPath,
  type RecordId,
  type SessionPullRequestAssociation,
} from '@factory/contract'
import { deriveAssociations, verifyAssociationBatch, type ManualAssociation } from '@factory/domain'
import {
  GithubPrObserver,
  observeGithubRepositoryMapping,
  persistGithubRepositoryMapping,
  persistPullRequestEvidence,
} from '@factory/github'
import { GitObserver, type PublicationPreparation, type RepositoryStore } from '@factory/repository'
import { SanitizationError } from '@factory/sanitization'

import { loadCandidateEvidence } from './candidate-loader'
import { openReviewRepositoryReader } from './repository-reader'

/** Refresh the exact workspace or PR evidence that becomes a review subject. */
export async function observeReviewSubject(
  repositoryRoot: string,
  store: RepositoryStore,
  pullRequest: number | undefined,
  environment: NodeJS.ProcessEnv,
  options: { manual?: readonly ManualAssociation[] } = {},
): Promise<OwnedPath> {
  const preparation = await store.preparePublication()
  const sanitizer = preparation.sanitizer
  return await observePreparedSubject(
    repositoryRoot,
    store,
    pullRequest,
    environment,
    preparation,
    (options.manual ?? []).map(assertion => prepareManualAssertion(assertion, sanitizer)),
  )
}

type SubjectSanitizer = PublicationPreparation['sanitizer']

function requireSafeSessionKey(sessionKey: string, sanitizer: SubjectSanitizer): void {
  if (sanitizer.text(sessionKey).redacted) throw new SanitizationError('unsupported-content')
}

function prepareManualAssertion(
  assertion: ManualAssociation,
  sanitizer: SubjectSanitizer,
): ManualAssociation {
  requireSafeSessionKey(assertion.sessionKey, sanitizer)
  return {
    ...assertion,
    actor: sanitizer.text(assertion.actor).text,
    reason: sanitizer.text(assertion.reason).text,
  }
}

async function observePreparedSubject(
  repositoryRoot: string,
  store: RepositoryStore,
  pullRequest: number | undefined,
  environment: NodeJS.ProcessEnv,
  preparation: PublicationPreparation,
  manual: readonly ManualAssociation[],
): Promise<OwnedPath> {
  const sanitizer = preparation.sanitizer
  const objects = {
    put: async (bytes: Uint8Array, metadata: { mediaType: string; role: string }) =>
      await store.putObject(preparation.prepareObject(bytes, metadata)),
  }
  if (pullRequest === undefined) {
    const observationId = newRecordId('observation')
    const observed = await new GitObserver(
      repositoryRoot,
      { ...objects, get: async reference => await store.getObject(reference) },
      { repositoryId: store.manifest.repositoryId, observationId, sanitizer },
    ).observe()
    if (observed.kind === 'unavailable')
      throw new Error(`workspace observation unavailable: ${observed.reason.code}`)
    const observation = observed.kind === 'raced' ? observed.partial : observed.observation
    const path = `repository-observations/${observation.observationId}.json` as OwnedPath
    await store.createImmutable(
      preparation.prepareRecord(path, new TextEncoder().encode(canonicalJson(observation))),
    )
    return path
  }

  const candidateRecords = (await store.readRecords()).records
  const reader = await openReviewRepositoryReader(store.factoryRoot)
  const triggerRecords = candidateRecords.filter(record =>
    /^review-triggers\/[^/]+\.json$/.test(record.path),
  )
  if (triggerRecords.length > 10_000)
    throw new Error('pull-request association trigger inventory exceeds its bound')
  const candidates = new Array<Awaited<ReturnType<typeof loadCandidateEvidence>>>()
  for (let offset = 0; offset < triggerRecords.length; offset += 8) {
    candidates.push(
      ...(await Promise.all(
        triggerRecords.slice(offset, offset + 8).map(async record => {
          const triggerId = record.path.slice(
            'review-triggers/'.length,
            -'.json'.length,
          ) as RecordId
          return await loadCandidateEvidence(reader, {
            triggerId,
            scopeProof: { kind: 'workspace-store', repositoryId: store.manifest.repositoryId },
          })
        }),
      )),
    )
  }
  const sessions = candidates.flatMap(candidate => {
    if (
      !('trigger' in candidate) ||
      candidate.repositoryObservation === undefined ||
      candidate.identity.repositoryId !== store.manifest.repositoryId
    )
      return []
    return [
      {
        provider: candidate.trigger.provider,
        turn: candidate.turn,
        repositoryObservation: candidate.repositoryObservation,
      },
    ]
  })
  const availableSessionKeys = new Set(sessions.map(session => session.turn.sessionKey))
  for (const assertion of manual) {
    if (!availableSessionKeys.has(assertion.sessionKey))
      throw new Error('manual association session is unavailable')
  }

  const hostname = (environment.GH_HOST ?? 'github.com').toLowerCase()
  const mapping = await observeGithubRepositoryMapping(store.manifest.repositoryId, hostname, {
    sanitizer,
    objects,
    cwd: repositoryRoot,
    environment,
  })
  if ('availability' in mapping)
    throw new Error(`pull-request repository mapping unavailable: ${mapping.reason}`)
  await persistGithubRepositoryMapping(store, mapping, preparation)
  const [owner, name, ...extra] = mapping.repository.split('/')
  if (!owner || !name || extra.length !== 0)
    throw new Error('pull-request repository mapping returned an invalid name')
  const observation = await new GithubPrObserver({
    sanitizer,
    objects,
    cwd: repositoryRoot,
    environment,
  }).observe({
    hostname: mapping.hostname,
    owner,
    name,
    number: pullRequest,
  })
  if (observation.availability === 'unavailable') {
    if (observation.record !== undefined)
      await persistPullRequestEvidence(store, observation.record, [], { preparation })
    throw new Error(`pull-request observation unavailable: ${observation.reason}`)
  }

  const records = (await store.readRecords()).records
  const recordByPath = new Map(records.map(record => [record.path, record.value]))
  const repositoryMappings = records
    .filter(record => record.path.includes('/repository-mappings/'))
    .map(record => record.value as unknown as GithubRepositoryMappingObservation)
  const priorPullRequests = new Map(
    records
      .filter(
        record =>
          new RegExp(
            `^pull-requests/github/${observation.repositoryKey}/${observation.number}/observations/[^/]+\\.json$`,
          ).test(record.path) &&
          (record.value as { availability?: string }).availability === 'available' &&
          (record.value as { observationId?: string }).observationId !== observation.observationId,
      )
      .map(record => {
        const value = record.value as unknown as AvailablePullRequestObservation
        return [value.observationId, value] as const
      }),
  )
  const associationRoot = `pull-requests/github/${observation.repositoryKey}/${observation.number}/associations/`
  const previous = records
    .filter(
      record =>
        record.path.startsWith(associationRoot) && /\/batches\/[^/]+\.json$/.test(record.path),
    )
    .flatMap(record => {
      const batch = record.value as unknown as AssociationBatch
      const pullRequest = priorPullRequests.get(batch.pullRequestObservationId)
      if (pullRequest === undefined) return []
      const root = `${associationRoot}${batch.pullRequestObservationId}`
      const evidence = batch.evidence.flatMap(reference => {
        const value = recordByPath.get(`${root}/${reference.evidenceId}.json` as OwnedPath)
        return value === undefined ? [] : [value as unknown as SessionPullRequestAssociation]
      })
      if (!verifyAssociationBatch(batch, pullRequest, evidence)) return []
      return evidence.map(association => ({ pullRequest, association }))
    })
  const inheritedManual = previous.flatMap(({ association }) =>
    association.kind === 'manual'
      ? [
          {
            sessionKey: association.sessionKey,
            actor: association.assertion.actor,
            reason: association.assertion.reason,
            observedAt: association.observedAt,
          },
        ]
      : [],
  )
  const associations = deriveAssociations({
    pullRequest: observation,
    sessions,
    repositoryMappings,
    manual: [
      ...inheritedManual.map(assertion => prepareManualAssertion(assertion, sanitizer)),
      ...manual,
    ],
    previous,
  })
  for (const association of associations) requireSafeSessionKey(association.sessionKey, sanitizer)
  await persistPullRequestEvidence(store, observation, associations, { preparation })
  return `pull-requests/github/${observation.repositoryKey}/${observation.number}/observations/${observation.observationId}.json` as OwnedPath
}

/** Observe one PR and append one explicitly asserted Session association. */
export async function associateReviewSession(
  repositoryRoot: string,
  store: RepositoryStore,
  pullRequest: number,
  assertion: { sessionKey: string; actor: string; reason: string },
  environment: NodeJS.ProcessEnv,
): Promise<{ subjectPath: OwnedPath; associationPath: OwnedPath }> {
  const observedAt = new Date().toISOString()
  const preparation = await store.preparePublication()
  const prepared = prepareManualAssertion({ ...assertion, observedAt }, preparation.sanitizer)
  const subjectPath = await observePreparedSubject(
    repositoryRoot,
    store,
    pullRequest,
    environment,
    preparation,
    [prepared],
  )
  const records = (await store.readRecords()).records
  const subject = records.find(record => record.path === subjectPath)?.value as
    | { observationId?: string }
    | undefined
  if (subject?.observationId === undefined) throw new Error('manual association subject is absent')
  const association = records.find(record => {
    const value = record.value as {
      kind?: string
      sessionKey?: string
      pullRequestObservationId?: string
      observedAt?: string
      assertion?: { actor?: string; reason?: string }
    }
    return (
      record.path.includes('/associations/') &&
      !record.path.includes('/batches/') &&
      value.kind === 'manual' &&
      value.sessionKey === prepared.sessionKey &&
      value.pullRequestObservationId === subject.observationId &&
      value.observedAt === observedAt &&
      value.assertion?.actor === prepared.actor &&
      value.assertion.reason === prepared.reason
    )
  })
  if (association === undefined) throw new Error('manual association was not persisted')
  return { subjectPath, associationPath: association.path }
}
