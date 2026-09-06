import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'

import {
  canonicalJson,
  parseCodeManifest,
  type JsonValue,
  type OwnedPath,
  type Sha256,
} from '@factory/contract'

import { restorePreparedObject, restorePreparedRecord } from './admission-internal'
import { discoverRepositorySanitizer } from './git-observer'
import { validateStructuredRecord } from './record-validation'

type Sanitizer = Awaited<ReturnType<typeof discoverRepositorySanitizer>>
const hashFields = new Set([
  'sha256',
  'worktreeFingerprint',
  'startState',
  'endState',
  'subjectFingerprint',
  'fingerprint',
  'coverageId',
  'problemId',
  'bundleSha256',
  'assertionFingerprint',
  'expectedStateFingerprint',
  'acceptedProblemIds',
])
const gitFields = new Set([
  'sha',
  'head',
  'index',
  'gitObject',
  'commits',
  'shas',
  'baseSha',
  'headSha',
  'mergeBase',
])
const recordFields = new Set([
  'entryId',
  'eventId',
  'turnId',
  'observationId',
  'repositoryObservationId',
  'pullRequestObservationId',
  'evidenceId',
  'invalidates',
  'batchId',
  'triggerId',
  'reviewId',
  'actionId',
  'reviewEntryId',
  'targetObservationId',
  'disputeActionId',
  'fromObservationId',
  'toObservationId',
  'previousActionId',
  'triggerIds',
  'associationBatchIds',
  'sourceObservationIds',
  'acceptedTriggerIds',
])
const enumFields = new Set([
  'kind',
  'provider',
  'algorithm',
  'encoding',
  'effect',
  'verdict',
  'confidence',
  'disposition',
  'materialization',
  'code',
  'policy',
  'status',
  'failureReason',
  'mode',
  'omissionReasons',
  'format',
])

// Only invoked after the complete, closed public schema has validated. Opaque
// payloads are routed out before field classification, so an assertion naming
// its own "sha256" never acquires structural authority.
function assertPreparedValue(value: JsonValue, sanitizer: Sanitizer, field = '', depth = 0): void {
  if (depth > 64) throw new TypeError('publication record exceeds nesting bound')
  if (field === 'assertion' || field === 'parsed') {
    if (field === 'assertion' && value === null) return
    if (sanitizer.json(value).redacted)
      throw new TypeError('record contains unprocessed opaque content')
    return
  }
  if (typeof value === 'string') {
    if (hashFields.has(field) && /^[a-f0-9]{64}$/.test(value)) return
    if (gitFields.has(field) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) return
    if (recordFields.has(field) && /^[a-z][a-z0-9-]*_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value))
      return
    if (field === 'containerImageDigest' && /^sha256:[a-f0-9]{64}$/.test(value)) return
    if (field === 'repositoryId' && /^repo_[A-Za-z0-9_-]+$/.test(value)) return
    if (field === 'sessionKey' && /^(?:codex|claude)-[a-f0-9]{32}$/.test(value)) return
    if (enumFields.has(field)) return
    if (sanitizer.text(value).redacted) throw new TypeError('record contains unprocessed free text')
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) assertPreparedValue(child, sanitizer, field, depth + 1)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (value.encoding === 'base64' && typeof value.bytes === 'string') {
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(value.bytes, 'base64'),
    )
    if (sanitizer.text(decoded).redacted)
      throw new TypeError('record contains unprocessed encoded path')
    if (typeof value.display === 'string')
      assertPreparedValue(value.display, sanitizer, 'display', depth + 1)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      field === 'sessionWatermarks' ||
      field === 'coverageTargetWatermarks' ||
      field === 'settledWatermarks'
    ) {
      assertPreparedValue(key, sanitizer, 'sessionKey', depth + 1)
      continue
    }
    assertPreparedValue(child, sanitizer, key, depth + 1)
  }
}

export {
  snapshotPreparedObject,
  snapshotPreparedRecord,
  type PreparedObject,
  type PreparedRecord,
} from './admission-internal'

export async function preparePublication(repositoryRoot: string) {
  const root = await realpath(repositoryRoot)
  const sanitizer = Object.freeze(await discoverRepositorySanitizer(root))
  return {
    sanitizer,
    prepareObject(bytes: Uint8Array, metadata: { mediaType: string; role: string }) {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      if (text.includes('\0')) throw new TypeError('unsupported publication content')
      let safe: string
      if (metadata.role === 'workspace-code-manifest') {
        const value = parseCodeManifest(JSON.parse(text))
        assertPreparedValue(value as unknown as JsonValue, sanitizer)
        safe = canonicalJson(value)
        if (safe !== text) throw new TypeError('code manifest is not canonical')
      } else if (metadata.mediaType === 'application/x-ndjson') {
        if (text && !text.endsWith('\n')) throw new TypeError('NDJSON object must end with newline')
        safe =
          text === ''
            ? ''
            : text
                .slice(0, -1)
                .split('\n')
                .map(line => canonicalJson(sanitizer.json(JSON.parse(line)).value))
                .join('')
      } else
        safe = metadata.mediaType.includes('json')
          ? canonicalJson(sanitizer.json(JSON.parse(text)).value)
          : sanitizer.text(text).text
      const content = Buffer.from(safe)
      for (const field of [metadata.mediaType, metadata.role])
        if (sanitizer.text(field).redacted) throw new TypeError('unprocessed object metadata')
      return restorePreparedObject(
        root,
        {
          algorithm: 'sha256',
          sha256: createHash('sha256').update(content).digest('hex') as Sha256,
          bytes: content.byteLength,
          ...metadata,
        },
        content,
      )
    },
    prepareRecord(path: OwnedPath, bytes: Uint8Array) {
      validateStructuredRecord(path, bytes)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const values = path.endsWith('.jsonl')
        ? text === ''
          ? []
          : text
              .trimEnd()
              .split('\n')
              .map(line => JSON.parse(line) as JsonValue)
        : [JSON.parse(text) as JsonValue]
      for (const value of values) assertPreparedValue(value, sanitizer)
      return restorePreparedRecord(root, path, bytes)
    },
  }
}

export type PublicationPreparation = Awaited<ReturnType<typeof preparePublication>>
