import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalJson } from '@factory/contract'

import { writerChoice } from '../../test-harness/src/choice-fixtures'

if (process.env.FACTORY_DOCKER_TEST !== '1') throw new Error('Submission tests require Docker')

async function batch(root: string, calls: { name: string; arguments: unknown }[]) {
  const bundlePath = new URL(
    '../../../specs/done/factory-v1/assets/review-plan/complete-bundle',
    import.meta.url,
  ).pathname
  const report = JSON.parse(await readFile(join(bundlePath, '../report.json'), 'utf8'))
  const child = Bun.spawn(
    [
      'bun',
      new URL('../docker/submission-server.ts', import.meta.url).pathname,
      bundlePath,
      report.bundles.complete,
      join(root, 'submissions.jsonl'),
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  const messages = [
    {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '1' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...calls.map((params, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'tools/call',
      params,
    })),
  ]
  child.stdin.write(messages.map(message => JSON.stringify(message) + '\n').join(''))
  child.stdin.end()
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  return stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
    .filter(response => response.id !== 0)
    .map(response => response.result)
}

test('invalid verdict retries and key conflicts cannot mutate prior acknowledged choices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-audit-retry-'))
  try {
    const choice = {
      ...writerChoice,
      verdict: 'unsound',
      evidence: [{ evidenceId: 'e1' }],
      correctedDecision: 'Use one durable writer.',
    }
    const { correctedDecision: _correction, ...invalid } = choice
    const replies = await batch(root, [
      { name: 'submit_choice', arguments: invalid },
      { name: 'submit_choice', arguments: choice },
      { name: 'submit_choice', arguments: choice },
      { name: 'submit_choice', arguments: { ...choice, assertion: { owner: 'hook' } } },
      { name: 'finish_audit', arguments: {} },
      {
        name: 'submit_audit_summary',
        arguments: {
          reviewed: 'Read synthetic capture history.',
          evidence: [{ evidenceId: 'e1' }],
        },
      },
      { name: 'finish_audit', arguments: {} },
      { name: 'finish_audit', arguments: {} },
    ])
    expect(replies.map(reply => reply.isError)).toEqual([
      true,
      false,
      false,
      true,
      true,
      false,
      false,
      false,
    ])
    expect(replies[0].content[0].text).toContain('correctedDecision')
    expect(replies[3].content[0].text).toContain('choice key')
    const events = (await readFile(join(root, 'submissions.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(events.map(event => event.kind)).toEqual(['choice', 'audit-summary', 'finish'])
    expect(events[0].choice).toMatchObject({
      assertion: writerChoice.assertion,
      correctedDecision: choice.correctedDecision,
    })
    expect(JSON.stringify(replies)).not.toContain(choice.correctedDecision)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('malicious direct journal content is never repaired or extended into an accepted audit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-audit-corrupt-'))
  try {
    const raw = '{"kind":"choice","secret-fixture":"not-a-valid-event"}\n'
    await writeFile(join(root, 'submissions.jsonl'), raw)
    const result = await batch(root, [
      { name: 'submit_choice', arguments: { ...writerChoice, evidence: [{ evidenceId: 'e1' }] } },
    ])
    expect(result[0].isError).toBeTrue()
    expect(await readFile(join(root, 'submissions.jsonl'), 'utf8')).toBe(raw)
    expect(JSON.stringify(result)).not.toContain('secret-fixture')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('aggregate overflow retains the acknowledged prefix within both durable bounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-audit-bound-'))
  try {
    const result = await batch(
      root,
      Array.from({ length: 40 }, (_, index) => ({
        name: 'submit_choice',
        arguments: {
          ...writerChoice,
          choiceKey: `bounded-${index}`,
          scenario: 's'.repeat(16 * 1024),
          rationale: 'r'.repeat(16 * 1024),
          evidence: [{ evidenceId: 'e1' }],
        },
      })),
    )
    expect(result[0].isError).toBeFalse()
    expect(result.at(-1).isError).toBeTrue()
    const raw = await readFile(join(root, 'submissions.jsonl'), 'utf8')
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(1024 * 1024)
    expect(JSON.parse(raw.split('\n')[0]!).choice.assertion).toEqual(writerChoice.assertion)
    expect(raw).not.toContain('bounded-39')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('acknowledged submissions survive SIGKILL and exact retry after process restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-audit-crash-'))
  const bundlePath = new URL(
    '../../../specs/done/factory-v1/assets/review-plan/complete-bundle',
    import.meta.url,
  ).pathname
  const report = JSON.parse(await readFile(join(bundlePath, '../report.json'), 'utf8'))
  const child = Bun.spawn(
    [
      'bun',
      new URL('../docker/submission-server.ts', import.meta.url).pathname,
      bundlePath,
      report.bundles.complete,
      join(root, 'submissions.jsonl'),
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  const choice = { ...writerChoice, evidence: [{ evidenceId: 'e1' }] }
  child.stdin.write(
    [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'fixture', version: '1' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'submit_choice', arguments: choice },
      },
    ]
      .map(value => JSON.stringify(value) + '\n')
      .join(''),
  )
  await child.stdin.flush()
  try {
    const reader = child.stdout.getReader()
    let text = ''
    while (
      !text
        .split('\n')
        .filter(Boolean)
        .some(line => JSON.parse(line).id === 2)
    ) {
      const next = await reader.read()
      if (next.done) throw new Error('server exited before acknowledgement')
      text += new TextDecoder().decode(next.value)
    }
    expect(JSON.parse(text.trim().split('\n').at(-1)!).result.isError).toBeFalse()
    child.kill('SIGKILL')
    await child.exited
    const before = await readFile(join(root, 'submissions.jsonl'), 'utf8')
    const result = await batch(root, [{ name: 'submit_choice', arguments: choice }])
    expect(result[0].isError).toBeFalse()
    expect(await readFile(join(root, 'submissions.jsonl'), 'utf8')).toBe(before)
    expect(JSON.parse(before).choice.assertion).toEqual(writerChoice.assertion)
  } finally {
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
})

test('stdio submission resolves a compact evidence handle into a durable canonical event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-audit-'))
  const bundlePath = new URL(
    '../../../specs/done/factory-v1/assets/review-plan/complete-bundle',
    import.meta.url,
  ).pathname
  const manifest = JSON.parse(await readFile(join(bundlePath, 'bundle.json'), 'utf8'))
  const report = JSON.parse(await readFile(join(bundlePath, '../report.json'), 'utf8'))
  const choice = {
    ...writerChoice,
    assertion: { nested: { values: [1, 'two'] } },
    scenario: writerChoice.scenario + '\nA second paragraph needs no shell escaping.',
    evidence: [{ evidenceId: 'e1' }],
  }
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '1' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'submit_choice', arguments: choice },
    },
  ]
  const child = Bun.spawn(
    [
      'bun',
      new URL('../docker/submission-server.ts', import.meta.url).pathname,
      bundlePath,
      report.bundles.complete,
      join(root, 'submissions.jsonl'),
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  child.stdin.write(requests.map(request => JSON.stringify(request) + '\n').join(''))
  child.stdin.end()
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(
      stdout
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
        .find(response => response.id === 2)?.result.isError,
    ).toBeFalse()
    const tools = stdout
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .find(response => response.id === 3).result.tools
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      'submit_choice',
      'submit_audit_summary',
      'finish_audit',
    ])
    expect(tools[0].inputSchema.required).toContain('headline')
    expect(tools[0].inputSchema.properties.evidence.items.required).toEqual(['evidenceId'])
    expect(tools[2].inputSchema).toEqual({ type: 'object', additionalProperties: false })
    expect(await readFile(join(root, 'submissions.jsonl'), 'utf8')).toBe(
      canonicalJson({
        kind: 'choice',
        choice: { ...choice, evidence: [{ object: manifest.inventory[0] }] },
      }),
    )
  } finally {
    child.kill()
    await rm(root, { recursive: true, force: true })
  }
})
