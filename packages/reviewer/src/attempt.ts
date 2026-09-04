import { canonicalJson, type RecordId } from '@factory/contract'

import type { ReviewerChoice } from './bundle'

export type ReviewerExecutionTermination =
  | 'completed'
  | 'timed-out'
  | 'cancelled'
  | 'crashed'
  | 'authentication-unavailable'
  | 'docker-unavailable'

export type ReviewerRawAttemptSnapshot = {
  reviewId: RecordId
  response: Uint8Array
  termination: ReviewerExecutionTermination
  exitCode: number | null
  outputTruncated: boolean
  reviewer: ReviewerChoice
  imageDigest: string
  providerCliVersion: string | null
  hostPlatform: string
  startedAt: string
  completedAt: string
}

declare const reviewerRawAttemptBrand: unique symbol
export type ReviewerRawAttempt = { readonly [reviewerRawAttemptBrand]: true }

const attempts = new WeakMap<object, ReviewerRawAttemptSnapshot>()

function snapshot(value: ReviewerRawAttemptSnapshot): ReviewerRawAttemptSnapshot {
  const { response: _response, ...facts } = value
  return {
    ...(JSON.parse(canonicalJson(facts)) as Omit<ReviewerRawAttemptSnapshot, 'response'>),
    response: value.response.slice(),
  }
}

/** Package-internal minting seam. The executor and coordinator own observed attempt facts. */
export function sealReviewerRawAttempt(value: ReviewerRawAttemptSnapshot): ReviewerRawAttempt {
  const unavailable =
    value.termination === 'authentication-unavailable' || value.termination === 'docker-unavailable'
  if (value.termination === 'completed' && !Number.isInteger(value.exitCode))
    throw new TypeError('completed reviewer attempt requires an integer exit code')
  if (
    unavailable &&
    (value.exitCode !== null ||
      value.response.byteLength !== 0 ||
      value.outputTruncated ||
      value.providerCliVersion !== null)
  )
    throw new TypeError('unavailable reviewer attempt contains unobserved execution facts')
  if (value.termination === 'completed' && value.providerCliVersion === null)
    throw new TypeError('completed reviewer attempt requires an observed provider version')
  const capability = Object.freeze({}) as ReviewerRawAttempt
  attempts.set(capability, snapshot(value))
  return capability
}

export function readReviewerRawAttempt(attempt: ReviewerRawAttempt): ReviewerRawAttemptSnapshot {
  const value = attempts.get(attempt)
  if (value === undefined) throw new TypeError('reviewer attempt capability is not verified')
  return snapshot(value)
}
