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
import { deriveAssociations, verifyAssociationBatch } from '@factory/domain'
import {
  GithubPrObserver,
  observeGithubRepositoryMapping,
  persistGithubRepositoryMapping,
  persistPullRequestEvidence,
} from '@factory/github'
import { GitObserver, type RepositoryStore } from '@factory/repository'

import { loadCandidateEvidence } from './candidate-loader'
import { openReviewRepositoryReader } from './repository-reader'

/** Refresh the exact workspace or PR evidence that becomes a review subject. */
export async function observeReviewSubject(
  repositoryRoot: string,
  store: RepositoryStore,
  pullRequest: number | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<OwnedPath> {
  const objects = {
    put: async (bytes: Uint8Array, metadata: { mediaType: string; role: string }) =>
      await store.putObject(
        (async function* () {
          yield bytes
        })(),
        metadata,
      ),
  }
  if (pullRequest === undefined) {
    const observationId = newRecordId('observation')
    const observed = await new GitObserver(
      repositoryRoot,
      { ...objects, get: async reference => await store.getObject(reference) },
      { repositoryId: store.manifest.repositoryId, observationId },
    ).observe()
    if (observed.kind === 'unavailable')
      throw new Error(`workspace observation unavailable: ${observed.reason.code}`)
    const observation = observed.kind === 'raced' ? observed.partial : observed.observation
    const path = `repository-observations/${observation.observationId}.json` as OwnedPath
    await store.createImmutable(path, new TextEncoder().encode(canonicalJson(observation)))
    return path
  }

  const hostname = (environment.GH_HOST ?? 'github.com').toLowerCase()
  const mapping = await observeGithubRepositoryMapping(store.manifest.repositoryId, hostname, {
    objects,
    cwd: repositoryRoot,
    environment,
  })
  if ('availability' in mapping)
    throw new Error(`pull-request repository mapping unavailable: ${mapping.reason}`)
  await persistGithubRepositoryMapping(store, mapping)
  const [owner, name, ...extra] = mapping.repository.split('/')
  if (!owner || !name || extra.length !== 0)
    throw new Error('pull-request repository mapping returned an invalid name')
  const observation = await new GithubPrObserver({
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
      await persistPullRequestEvidence(store, observation.record, [])
    throw new Error(`pull-request observation unavailable: ${observation.reason}`)
  }

  const records = (await store.readRecords()).records
  const recordByPath = new Map(records.map(record => [record.path, record.value]))
  const reader = await openReviewRepositoryReader(store.factoryRoot)
  const triggerRecords = records.filter(record =>
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
  const associations = deriveAssociations({
    pullRequest: observation,
    sessions,
    repositoryMappings,
    previous,
  })
  await persistPullRequestEvidence(store, observation, associations)
  return `pull-requests/github/${observation.repositoryKey}/${observation.number}/observations/${observation.observationId}.json` as OwnedPath
}
