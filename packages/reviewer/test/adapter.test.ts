import { describe, expect, test } from 'bun:test'

import { reviewerAdapter } from '../src'

describe('review provider adapters', () => {
  test('pins direct Codex argv, isolated auth home, and response file', () => {
    const invocation = reviewerAdapter({ provider: 'codex', model: 'gpt-test', effort: 'high' })
    for (const value of [
      '--ephemeral',
      '--ignore-user-config',
      '--strict-config',
      '--output-last-message',
      '/out/response.txt',
    ])
      expect(invocation.argv).toContain(value)
    const sandbox = invocation.argv.indexOf('--sandbox')
    expect(invocation.argv.slice(sandbox, sandbox + 2)).toEqual([
      '--sandbox',
      'danger-full-access',
    ])
    expect(invocation.environment.CODEX_HOME).toBe('/auth/codex')
    expect(invocation.prompt).toContain('/review-input')
    expect(invocation.prompt).toContain('"decisionKey":"explicit stable opaque key"')
    expect(invocation.prompt).toContain('Omission never means removal')
    expect(invocation.prompt).toContain('MUST emit at least one cited summary')
  })

  test('pins restricted Claude argv without fallback or persistence', () => {
    const invocation = reviewerAdapter({ provider: 'claude', model: 'opus', effort: 'high' })
    for (const value of [
      '--safe-mode',
      '--restricted',
      '--strict-mcp-config',
      '--no-session-persistence',
      '/review-input',
    ])
      expect(invocation.argv).toContain(value)
    const mcpConfig = invocation.argv.indexOf('--mcp-config')
    expect(invocation.argv.slice(mcpConfig, mcpConfig + 2)).toEqual([
      '--mcp-config',
      '{"mcpServers":{}}',
    ])
    expect(invocation.argv).not.toContain('--fallback-model')
    expect(invocation.environment.CLAUDE_CONFIG_DIR).toBe('/auth/claude')
    expect(invocation.response).toEqual({ kind: 'stdout' })
  })

  test('rejects unsupported effort rather than claiming reproducibility', () => {
    expect(() => reviewerAdapter({ provider: 'codex', model: 'gpt-test', effort: 'max' })).toThrow(
      'unsupported',
    )
  })
})
