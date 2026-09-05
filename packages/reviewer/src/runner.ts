import type { ReviewerAdapterInvocation } from './adapter.js'
import type { MountPlan } from './isolation.js'
import { runObservedReviewerContainer, type ProbeTermination } from './probe.js'

export type ReviewerContainerOptions = {
  imageDigest: string
  expectedBundleSha256: string
  reviewer: { model: string; effort: string; promptVersion: string }
  invocation: ReviewerAdapterInvocation
  containerIdentity: { name: string; label: string }
  timeoutMs: number
  signal?: AbortSignal
}

export type ReviewerContainerResult = {
  termination: ProbeTermination
  exitCode: number | null
  providerCliVersion: string | null
}

/** Run one production reviewer through the shared observed container lifecycle. */
export async function runReviewerContainer(
  plan: MountPlan,
  options: ReviewerContainerOptions,
): Promise<ReviewerContainerResult> {
  const report = await runObservedReviewerContainer(plan, {
    ...options,
    scenario: 'review',
  })
  return {
    termination: report.termination,
    exitCode: report.exitCode,
    providerCliVersion: report.observation?.providerVersion ?? null,
  }
}
