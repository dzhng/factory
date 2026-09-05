import { describe, expect, test } from 'bun:test'

import { runDiagnostics } from '../src/diagnostics'

describe('diagnostic policy', () => {
  test('prioritizes canonical drift and blocked review without probing', () => {
    const diagnostics = runDiagnostics({
      repositoryIssues: [],
      projectionIssues: [],
      runtime: { state: 'absent', storageBytes: 0 },
      installation: {
        ownership: 'absent',
        executable: { path: null, state: 'unconfigured' },
        transaction: 'absent',
        providers: {
          codex: { path: '/codex/hooks.json', config: 'missing', hooks: { events: [] } },
          claude: { path: '/claude/settings.json', config: 'missing', hooks: { events: [] } },
        },
      },
      github: { availability: 'available', branch: 'main' },
      reviewer: {
        docker: { availability: 'unavailable', reason: 'missing' },
        credentials: {
          codex: { state: 'unconfigured' },
          claude: { state: 'unconfigured' },
        },
      },
      canonicalBranch: 'release',
    })
    expect(diagnostics).toContainEqual({
      code: 'canonical-branch-drift',
      severity: 'high',
      summary: 'Canonical branch release differs from GitHub default main',
    })
    expect(diagnostics).toContainEqual({
      code: 'reviewer-docker-unavailable',
      severity: 'high',
      summary: 'Docker reviewer is unavailable: missing',
    })
  })

  test('aggregates hook states without exposing provider configuration', () => {
    const diagnostics = runDiagnostics({
      repositoryIssues: [],
      projectionIssues: [],
      runtime: { state: 'absent', storageBytes: 0 },
      installation: {
        ownership: 'available',
        executable: { path: '/factory', state: 'ready' },
        transaction: 'absent',
        providers: {
          codex: {
            path: '/codex/hooks.json',
            config: 'available',
            hooks: {
              events: [
                { event: 'Stop', state: 'missing' },
                { event: 'SessionEnd', state: 'stale' },
              ] as never,
            },
          },
          claude: { path: '/claude/settings.json', config: 'available', hooks: { events: [] } },
        },
      },
      github: { availability: 'unavailable', reason: 'gh-missing' },
      reviewer: {
        docker: { availability: 'available', version: '27.5.1' },
        credentials: { codex: { state: 'available' }, claude: { state: 'available' } },
      },
    })
    expect(diagnostics).toContainEqual({
      code: 'codex-hooks-unhealthy',
      severity: 'medium',
      summary: '1 missing, 1 stale',
    })
  })
})
