import { describe, expect, test } from 'bun:test'

import { reviewerAdapter } from '../src'

const bundleSha256 = 'a'.repeat(64)
const tools = ['submit_choice', 'submit_audit_summary', 'finish_audit']

describe('review provider adapters', () => {
  test('pins direct Codex argv, isolated auth home, and response file', () => {
    const invocation = reviewerAdapter(
      { provider: 'codex', model: 'gpt-test', effort: 'high' },
      bundleSha256,
    )
    for (const value of [
      '--ephemeral',
      '--ignore-user-config',
      '--strict-config',
      '--output-last-message',
      '/out/response.txt',
    ])
      expect(invocation.argv).toContain(value)
    const sandbox = invocation.argv.indexOf('--sandbox')
    expect(invocation.argv.slice(sandbox, sandbox + 2)).toEqual(['--sandbox', 'danger-full-access'])
    expect(invocation.environment.CODEX_HOME).toBe('/auth/codex')
    expect(invocation.prompt).toContain('/review-input')
    expect(invocation.prompt).toContain('Reuse a choiceKey only when cited evidence')
    expect(invocation.prompt).toContain('Silence changes nothing')
    expect(invocation.prompt).toContain('submit_audit_summary')
    expect(invocation.prompt).toContain('requires a null assertion')
    expect(invocation.prompt).toContain('finish_audit exactly once')
    const config = invocation.argv.filter((_, index) => invocation.argv[index - 1] === '--config')
    const servers = Bun.TOML.parse(
      config.find(value => value.startsWith('mcp_servers=')) ?? '',
    ) as { mcp_servers: Record<string, unknown> }
    expect(Object.keys(servers.mcp_servers)).toEqual(['factory_audit'])
    expect(servers.mcp_servers.factory_audit).toMatchObject({
      command: '/usr/local/bin/bun',
      args: [
        '/opt/factory/audit-server.js',
        '/review-input',
        bundleSha256,
        '/out/submissions.jsonl',
      ],
      enabled_tools: tools,
      required: true,
    })
  })

  test('pins restricted Claude argv without fallback or persistence', () => {
    const invocation = reviewerAdapter(
      { provider: 'claude', model: 'opus', effort: 'high' },
      bundleSha256,
    )
    for (const value of [
      '--restricted',
      '--strict-mcp-config',
      '--no-session-persistence',
      '/review-input',
    ])
      expect(invocation.argv).toContain(value)
    const mcpConfig = invocation.argv.indexOf('--mcp-config')
    const servers = JSON.parse(invocation.argv[mcpConfig + 1]!).mcpServers
    expect(Object.keys(servers)).toEqual(['factory_audit'])
    expect(servers.factory_audit).toEqual({
      type: 'stdio',
      command: '/usr/local/bin/bun',
      args: [
        '/opt/factory/audit-server.js',
        '/review-input',
        bundleSha256,
        '/out/submissions.jsonl',
      ],
    })
    expect(invocation.argv[invocation.argv.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
    expect(invocation.argv[invocation.argv.indexOf('--allowedTools') + 1]).toBe(
      ['Read', 'Glob', 'Grep', ...tools.map(tool => `mcp__factory_audit__${tool}`)].join(','),
    )
    expect(invocation.argv).not.toContain('--fallback-model')
    expect(invocation.argv).not.toContain('--safe-mode')
    expect(invocation.argv[invocation.argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(invocation.environment.CLAUDE_CONFIG_DIR).toBe('/auth/claude')
    expect(invocation.response).toEqual({ kind: 'stdout' })
  })

  test('rejects unsupported effort rather than claiming reproducibility', () => {
    expect(() =>
      reviewerAdapter({ provider: 'codex', model: 'gpt-test', effort: 'max' }, bundleSha256),
    ).toThrow('unsupported')
  })

  test('binds both providers to one evidence-aware prompt and a verified digest', () => {
    const codex = reviewerAdapter(
      { provider: 'codex', model: 'gpt-test', effort: 'high' },
      bundleSha256,
    )
    const claude = reviewerAdapter(
      { provider: 'claude', model: 'opus', effort: 'high' },
      bundleSha256,
    )
    expect(codex.prompt).toBe(claude.prompt)
    for (const text of [
      '[REDACTED]',
      'omission',
      'evidenceIndex',
      'not byte-identical',
      'diagnostic only',
    ])
      expect(codex.prompt).toContain(text)
    expect(codex.prompt).not.toContain('```')
    expect(() =>
      reviewerAdapter({ provider: 'codex', model: 'gpt-test', effort: 'high' }, 'wrong'),
    ).toThrow('digest')
  })
})
