#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { ReviewLedger } from '@factory/contract'
import type { ReviewBundleManifest } from '@factory/review-plan'

const provider = basename(process.argv[1] ?? '')
if (process.argv.includes('--version')) {
  process.stdout.write(`${provider}-fake/1\n`)
  process.exit(0)
}

const prompt = await new Response(Bun.stdin.stream()).text()
if (!prompt.includes('/review-input') || !prompt.includes('submit_choice'))
  throw new Error('Factory review prompt was not delivered on stdin')
const bundle = (await Bun.file('/review-input/bundle.json').json()) as ReviewBundleManifest
const authPath = provider === 'codex' ? '/auth/codex/auth.json' : '/auth/claude/.credentials.json'
const behavior = await Bun.file(authPath).text()
if (behavior.includes('factory-test-delay')) await Bun.sleep(1_500)
let decisionEvidence = bundle.inventory[0]
if (behavior.includes('factory-test-decision') && bundle.plan.priorLedger !== undefined) {
  const prior = (await Bun.file(
    `/review-input/.factory/${bundle.plan.priorLedger.path}`,
  ).json()) as ReviewLedger
  if (!prior.entries.some(entry => entry.choiceKey === 'release.certification'))
    throw new Error('Prior release decision was not delivered in the review bundle')
  decisionEvidence = bundle.plan.priorLedger.object
}
const unsound = behavior.includes('factory-test-unsound')
const events: {
  kind: string
  choice?: Record<string, unknown>
  summary?: Record<string, unknown>
}[] = []
if (behavior.includes('factory-test-decision') || unsound)
  events.push({
    kind: 'choice',
    choice: {
      choiceKey: 'release.certification',
      effect: 'assert',
      assertion: { artifact: 'verified' },
      when: 'When release certification was implemented',
      headline: 'Certify the exact release artifact',
      scenario:
        'A release is published after testing the packaged binary. Testing only source would leave packaging failures unobserved.',
      gap: 'The task did not specify which artifact certification should exercise.',
      reach: 'Future releases inherit the certification boundary.',
      verdict: unsound ? 'unsound' : 'sound',
      confidence: 'high',
      rationale: unsound
        ? 'The fixture deliberately reports an unsound certification choice.'
        : 'The artifact users install is the artifact tested.',
      ...(unsound ? { correctedDecision: 'Certify every installed release boundary.' } : {}),
      evidence: [{ object: decisionEvidence }],
    },
  })
if (behavior.includes('factory-test-verdicts'))
  for (const verdict of ['sound', 'unsound', 'needs-user'])
    events.push({
      kind: 'choice',
      choice: {
        choiceKey: `fixture.${verdict}`,
        effect: 'assert',
        assertion: { verdict, nested: { retained: true } },
        when: 'When synthetic provider behavior was specified',
        headline: `${verdict} synthetic decision`,
        scenario:
          'A release author selects a behavior without explicit direction.\nThe next release inherits it; a different choice would change certification.',
        gap: 'The user did not select this fixture behavior.',
        reach: 'Future releases inherit it.',
        verdict,
        confidence: 'high',
        rationale: 'This fixture pins the typed boundary, not a real model judgment.',
        ...(verdict === 'unsound'
          ? { correctedDecision: 'Specify the certification boundary first.' }
          : {}),
        ...(verdict === 'needs-user'
          ? {
              provisionalCall: 'Keep the reversible fixture default.',
              reversal: 'Select the user-preferred behavior before release.',
            }
          : {}),
        evidence: [{ object: bundle.inventory[0] }],
      },
    })
events.push({
  kind: 'audit-summary',
  summary: {
    reviewed: 'Inspected the synthetic release implementation and its explicit specification.',
    ...(events.length === 0
      ? {
          noChoiceRationale: 'The specification explicitly selected all observed release behavior.',
        }
      : {}),
    evidence: [{ object: bundle.inventory[0] }],
  },
})
if (!behavior.includes('factory-test-prefix')) events.push({ kind: 'finish' })
const argv = process.argv.slice(2)
const config =
  provider === 'codex'
    ? (
        Bun.TOML.parse(argv.find(value => value.startsWith('mcp_servers=')) ?? '') as {
          mcp_servers: { factory_audit: { command: string; args: string[] } }
        }
      ).mcp_servers.factory_audit
    : (JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!).mcpServers.factory_audit as {
        command: string
        args: string[]
      })
const server = Bun.spawn([config.command, ...config.args], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
})
const reader = server.stdout.getReader()
let pending = ''
let nextId = 0
async function call(
  method: string,
  params: unknown,
): Promise<{ isError?: boolean; tools?: { name: string }[] }> {
  const id = ++nextId
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  await server.stdin.flush()
  while (!pending.includes('\n')) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error('submission server exited before acknowledgement')
    pending += new TextDecoder().decode(chunk.value)
  }
  const newline = pending.indexOf('\n')
  const reply = JSON.parse(pending.slice(0, newline))
  pending = pending.slice(newline + 1)
  if (reply.id !== id || reply.error) throw new Error('submission server protocol failed')
  return reply.result
}
await call('initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'factory-isolated-fixture', version: '1' },
})
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
const listed = await call('tools/list', {})
if (
  listed.tools
    ?.map(tool => tool.name)
    .sort()
    .join(',') !== 'finish_audit,submit_audit_summary,submit_choice'
)
  throw new Error('configured tool surface differs')
for (const event of events) {
  const name =
    event.kind === 'choice'
      ? 'submit_choice'
      : event.kind === 'audit-summary'
        ? 'submit_audit_summary'
        : 'finish_audit'
  const value = event.choice ?? event.summary
  const args =
    value === undefined
      ? {}
      : {
          ...value,
          evidence: (value.evidence as { object: unknown }[]).map(citation => {
            const handle = bundle.evidenceIndex.find(entry =>
              Object.entries(entry.object).every(
                ([key, value]) => (citation.object as Record<string, unknown>)[key] === value,
              ),
            )
            if (handle === undefined) throw new Error('fixture citation absent from index')
            return { evidenceId: handle.evidenceId }
          }),
        }
  if (event.choice?.verdict === 'unsound' && behavior.includes('factory-test-verdicts')) {
    const invalid = { ...args, correctedDecision: undefined }
    if (!(await call('tools/call', { name, arguments: invalid })).isError)
      throw new Error('invalid choice was acknowledged')
  }
  if ((await call('tools/call', { name, arguments: args })).isError)
    throw new Error('valid fixture submission was refused')
  if (event.kind === 'choice' && (await call('tools/call', { name, arguments: args })).isError)
    throw new Error('exact retry was refused')
}
server.stdin.end()
if ((await server.exited) !== 0) throw new Error('submission server failed')
reader.releaseLock()
// Deliberate direct-file corruption tests the host boundary, not a supported submission channel.
if (behavior.includes('factory-test-oversized'))
  await writeFile(
    '/out/submissions.jsonl',
    (await readFile('/out/submissions.jsonl', 'utf8')).repeat(20_000),
  )
if (behavior.includes('factory-test-malformed'))
  await writeFile('/out/submissions.jsonl', 'untrusted malformed direct output\n')
const response = 'The synthetic choice audit has been submitted.\n'
if (provider === 'codex') {
  const outputIndex = process.argv.indexOf('--output-last-message')
  if (
    !process.argv.includes('--ephemeral') ||
    !process.argv.includes('--ignore-user-config') ||
    !process.argv.includes('--strict-config') ||
    process.argv.at(-1) !== '-' ||
    process.argv[outputIndex + 1] !== '/out/response.txt' ||
    process.env.CODEX_HOME !== '/auth/codex'
  )
    throw new Error('Codex adapter invocation differs from the pinned contract')
  await writeFile(
    '/out/response.txt',
    behavior.includes('factory-test-oversized') ? response.repeat(40_000) : response,
  )
} else {
  if (
    !process.argv.includes('--restricted') ||
    process.argv[process.argv.indexOf('--setting-sources') + 1] !== '' ||
    !process.argv.includes('--no-session-persistence') ||
    !process.argv.includes('/review-input') ||
    process.env.CLAUDE_CONFIG_DIR !== '/auth/claude'
  )
    throw new Error('Claude adapter invocation differs from the pinned contract')
  process.stdout.write(
    behavior.includes('factory-test-oversized') ? response.repeat(40_000) : response,
  )
}
if (behavior.includes('factory-test-prefix-timeout')) await new Promise(() => undefined)
if (behavior.includes('factory-test-prefix-nonzero')) process.exit(7)
