import { createHash } from 'node:crypto'

import { canonicalJson } from '@factory/contract'

import type { EffectiveReviewLimits, ReviewInputs, ReviewSubject } from './index'

export function effectiveLimits(configured: ReviewInputs['reviewLimits']): EffectiveReviewLimits {
  const clamp = (value: number | undefined, fallback: number, ceiling: number): number =>
    value === undefined || !Number.isSafeInteger(value) || value <= 0
      ? fallback
      : Math.min(value, ceiling)
  return {
    maxBundleBytes: clamp(configured?.maxBundleBytes, 256 * 1024 * 1024, 512 * 1024 * 1024),
    maxSessions: clamp(configured?.maxSessions, 100, 1_000),
    maxTreeEntries: 200_000,
    maxObjects: 100_000,
    maxDepth: 16,
    maxStructuredRecordBytes: 4 * 1024 * 1024,
  }
}

export function subjectFingerprint(subject: ReviewSubject): string {
  const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
  if (subject.kind === 'workspace') {
    const observation = subject.observation
    return hash({
      kind: subject.kind,
      ...(observation.git.head === undefined ? {} : { head: observation.git.head }),
      startState: observation.startState,
      endState: observation.endState,
      ...(observation.codeManifest === undefined ? {} : { codeManifest: observation.codeManifest }),
      ...(observation.stagedPatch === undefined ? {} : { stagedPatch: observation.stagedPatch }),
      ...(observation.unstagedPatch === undefined
        ? {}
        : { unstagedPatch: observation.unstagedPatch }),
    })
  }
  const observation = subject.observation
  return hash({
    kind: subject.kind,
    repositoryKey: observation.repositoryKey,
    number: observation.number,
    base: observation.base,
    head: observation.head,
    diff: observation.diff,
    ...(observation.codeManifest === undefined ? {} : { codeManifest: observation.codeManifest }),
  })
}
