import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  acceptAuditDraft,
  canonicalJson,
  type ChoiceAuditEvent,
  type ObjectRef,
} from '@factory/contract'

import { checkpointChoices } from './choice-fixtures'

if (process.env.FACTORY_DOCKER_TEST !== '1') throw new Error('Audit probe requires Docker')
const [serverPath, bundlePath, bundleSha256, outputPath] = process.argv.slice(2)
if (!serverPath || !bundlePath || !bundleSha256 || !outputPath)
  throw new Error('Audit probe arguments required')
await mkdir(outputPath, { recursive: true })
const manifest = JSON.parse(await readFile(join(bundlePath, 'bundle.json'), 'utf8')) as {
  inventory: ObjectRef[]
  evidenceIndex: { evidenceId: string; object: ObjectRef }[]
}
const evidence = manifest.evidenceIndex[0]!
const choices = checkpointChoices([{ object: evidence.object }]).map(choice => ({
  ...choice,
  scenario: `${choice.scenario}\nThis synthetic second paragraph crosses the typed protocol unchanged.`,
  evidence: [{ evidenceId: evidence.evidenceId }],
}))
const calls = [
  ...choices.map(arguments_ => ({ name: 'submit_choice', arguments: arguments_ })),
  {
    name: 'submit_audit_summary',
    arguments: {
      reviewed: 'Inspected synthetic storage, retry, and hosting histories.',
      evidence: [{ evidenceId: evidence.evidenceId }],
    },
  },
  { name: 'finish_audit', arguments: {} },
]
const messages = [
  {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'factory-audit-probe', version: '1' },
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
const child = Bun.spawn(
  ['bun', serverPath, bundlePath, bundleSha256, join(outputPath, 'submissions.jsonl')],
  { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
)
child.stdin.write(messages.map(message => JSON.stringify(message) + '\n').join(''))
child.stdin.end()
const [code, stdout, stderr] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
])
if (code !== 0 || stderr !== '') throw new Error('Audit probe server failed')
const replies = stdout
  .trimEnd()
  .split('\n')
  .map(line => JSON.parse(line))
if (replies.some(reply => reply.error || reply.result?.isError))
  throw new Error(`Audit probe submission rejected: ${JSON.stringify(replies)}`)
const raw = await readFile(join(outputPath, 'submissions.jsonl'), 'utf8')
const events = raw
  .trimEnd()
  .split('\n')
  .map(line => JSON.parse(line)) as ChoiceAuditEvent[]
const accepted = acceptAuditDraft(events, manifest.inventory, 'review_00000000000000000000000001')
if (accepted.incomplete || accepted.entries.length !== 3)
  throw new Error('Audit probe did not finish')
process.stdout.write(
  canonicalJson({
    authority: 'synthetic stdio protocol; no model or production provider configuration',
    incomplete: accepted.incomplete,
    draftBytes: Buffer.byteLength(raw),
    entries: accepted.entries,
    summary: accepted.summary,
  }),
)
