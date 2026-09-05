import type { CaptureProviderEnvironmentInspection } from '@factory/capture'
import type { GithubDefaultBranchObservation } from '@factory/github'
import type { ReviewerEnvironmentInspection } from '@factory/reviewer'
import type { RuntimeJournalInspection } from '@factory/runtime-journal'

import type { InstallationStatus } from './installation'

export type FactoryDiagnostic = {
  code: string
  severity: 'low' | 'medium' | 'high'
  summary: string
}

export type DiagnosticContext = {
  repositoryIssues: readonly { code: string; detail: string }[]
  projectionIssues: readonly string[]
  runtime: RuntimeJournalInspection
  installation: InstallationStatus
  github: GithubDefaultBranchObservation
  reviewer: ReviewerEnvironmentInspection
  providers: CaptureProviderEnvironmentInspection
  canonicalBranch?: string
}

/** Pure policy fold over owner-provided observations; it performs no probing or repair. */
export function runDiagnostics(context: DiagnosticContext): readonly FactoryDiagnostic[] {
  const diagnostics: FactoryDiagnostic[] = []
  for (const issue of context.repositoryIssues)
    diagnostics.push({
      code: `repository-${issue.code}`,
      severity: 'high',
      summary: issue.detail,
    })
  for (const issue of context.projectionIssues)
    diagnostics.push({ code: 'incomplete-committed-graph', severity: 'high', summary: issue })

  if (context.runtime.state === 'available') {
    if (context.runtime.pendingStops > 0)
      diagnostics.push({
        code: 'pending-stops',
        severity: 'medium',
        summary: `${context.runtime.pendingStops} captured Stop(s) await materialization`,
      })
    if (context.runtime.pendingLifecycle > 0)
      diagnostics.push({
        code: 'pending-lifecycle',
        severity: 'medium',
        summary: `${context.runtime.pendingLifecycle} lifecycle event(s) await materialization`,
      })
    if (context.runtime.diagnostics.length > 0)
      diagnostics.push({
        code: 'capture-failures-recorded',
        severity: 'medium',
        summary: `${context.runtime.diagnostics.length} private capture diagnostic(s) are recorded`,
      })
    if (context.runtime.diagnosticsTruncated)
      diagnostics.push({
        code: 'capture-diagnostic-inventory-truncated',
        severity: 'high',
        summary: 'Private capture diagnostics exceed the inspection bound',
      })
  }

  if (context.installation.ownership === 'invalid')
    diagnostics.push({
      code: 'installation-ownership-invalid',
      severity: 'high',
      summary: context.installation.ownershipError ?? 'Hook ownership state is invalid',
    })
  if (context.installation.transaction !== 'absent')
    diagnostics.push({
      code: `installation-transaction-${context.installation.transaction}`,
      severity: context.installation.transaction === 'invalid' ? 'high' : 'medium',
      summary:
        context.installation.transactionError ??
        (context.installation.transaction === 'pending'
          ? 'An interrupted installation transaction can be recovered'
          : 'The interrupted installation transaction is invalid'),
    })
  if (context.installation.executable.state !== 'ready')
    diagnostics.push({
      code: `installation-executable-${context.installation.executable.state}`,
      severity: context.installation.executable.state === 'unconfigured' ? 'medium' : 'high',
      summary: `Factory's installed executable is ${context.installation.executable.state}`,
    })
  for (const provider of ['codex', 'claude'] as const) {
    const status = context.installation.providers[provider]
    if (status.config !== 'available')
      diagnostics.push({
        code: `${provider}-hook-config-${status.config}`,
        severity: status.config === 'invalid' ? 'high' : 'low',
        summary:
          status.error ??
          `${provider} hook configuration is ${status.config === 'missing' ? 'not present' : 'invalid'}`,
      })
    const unhealthy = status.hooks?.events.filter(event => event.state !== 'installed') ?? []
    if (unhealthy.length > 0) {
      const counts = new Map<string, number>()
      for (const event of unhealthy) counts.set(event.state, (counts.get(event.state) ?? 0) + 1)
      diagnostics.push({
        code: `${provider}-hooks-unhealthy`,
        severity: 'medium',
        summary: [...counts]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([state, count]) => `${count} ${state}`)
          .join(', '),
      })
    }
  }

  if (context.reviewer.docker.availability === 'unavailable')
    diagnostics.push({
      code: 'reviewer-docker-unavailable',
      severity: 'high',
      summary: `Docker reviewer is unavailable: ${context.reviewer.docker.reason}`,
    })
  for (const provider of ['codex', 'claude'] as const) {
    const providerEnvironment = context.providers[provider]
    if (providerEnvironment.availability === 'unavailable')
      diagnostics.push({
        code: `${provider}-cli-unavailable`,
        severity: 'low',
        summary: `${provider} CLI is unavailable: ${providerEnvironment.reason}`,
      })
    const credentials = context.reviewer.credentials[provider]
    if (credentials.state !== 'available')
      diagnostics.push({
        code: `${provider}-reviewer-credentials-${credentials.state}`,
        severity: credentials.state === 'invalid' ? 'medium' : 'low',
        summary:
          credentials.reason === undefined
            ? `${provider} reviewer credential file is not configured`
            : `${provider} reviewer credential file is invalid: ${credentials.reason}`,
      })
  }

  diagnostics.push(...githubDiagnostics(context.github, context.canonicalBranch))
  return diagnostics
}

export function githubDiagnostics(
  github: GithubDefaultBranchObservation,
  canonicalBranch?: string,
): readonly FactoryDiagnostic[] {
  const diagnostics: FactoryDiagnostic[] = []
  if (github.availability === 'unavailable')
    diagnostics.push({
      code: 'github-unavailable',
      severity:
        github.reason === 'gh-missing' || github.reason === 'authentication-required'
          ? 'low'
          : 'medium',
      summary: `GitHub default branch is unavailable: ${github.reason}`,
    })
  else if (canonicalBranch !== undefined && canonicalBranch !== github.branch)
    diagnostics.push({
      code: 'canonical-branch-drift',
      severity: 'high',
      summary: `Canonical branch ${canonicalBranch} differs from GitHub default ${github.branch}`,
    })
  return diagnostics
}
