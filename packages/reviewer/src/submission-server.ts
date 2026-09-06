import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import {
  acceptAuditDraft,
  canonicalJson,
  readAuditDraft,
  validateChoiceAuditEvent,
  choiceAuditInputSchema,
  auditSummaryInputSchema,
  type ChoiceAuditEvent,
  type ObjectRef,
} from '@factory/contract'
import { withAdvisoryFileLock } from '@factory/repository'
import { verifyBundle } from '@factory/review-plan'

const MAX_DRAFT_BYTES = 1024 * 1024
const MAX_MESSAGE_BYTES = 128 * 1024
const draftReviewId = 'review_00000000000000000000000000' as const
const protocolVersion = '2025-11-25'
const toolNames = ['submit_choice', 'submit_audit_summary', 'finish_audit'] as const
const citationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    evidenceId: { type: 'string', pattern: '^e[1-9][0-9]*$' },
    locator: { type: 'string', minLength: 1, maxLength: 1024 },
  },
  required: ['evidenceId'],
}
const tools = [
  {
    name: toolNames[0],
    description:
      'Submit one standalone choice judgment with exact bundle evidence handles; 64 KiB per choice, 16 KiB per prose field, 500 choices and 1 MiB per audit. Exact retries succeed; conflicting keys are rejected.',
    inputSchema: choiceAuditInputSchema(citationSchema),
  },
  {
    name: toolNames[1],
    description:
      'Submit the cited account of histories reviewed. An audit with no choices requires noChoiceRationale before finishing.',
    inputSchema: auditSummaryInputSchema(citationSchema),
  },
  {
    name: toolNames[2],
    description: 'Finish after all choices and the cited scope summary. Exact retries succeed.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
]

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function resolveEvent(
  name: string,
  input: unknown,
  evidence: Map<string, ObjectRef>,
): ChoiceAuditEvent {
  if (!record(input)) throw new Error('invalid submission')
  if (name === 'finish_audit') {
    if (Object.keys(input).length !== 0) throw new Error('invalid finish')
    return { kind: 'finish' }
  }
  if (!Array.isArray(input.evidence)) throw new Error('citations required')
  const citations = input.evidence
    .map(value => {
      if (
        !record(value) ||
        Object.keys(value).some(key => !['evidenceId', 'locator'].includes(key)) ||
        typeof value.evidenceId !== 'string'
      )
        throw new Error('invalid citation')
      const object = evidence.get(value.evidenceId)
      if (!object) throw new Error('unknown evidence handle')
      return { object, ...('locator' in value ? { locator: value.locator } : {}) }
    })
    .sort((left, right) =>
      canonicalJson(left) < canonicalJson(right)
        ? -1
        : canonicalJson(left) > canonicalJson(right)
          ? 1
          : 0,
    )
  const payload = { ...input, evidence: citations }
  const event =
    name === 'submit_choice'
      ? { kind: 'choice', choice: payload }
      : { kind: 'audit-summary', summary: payload }
  validateChoiceAuditEvent(event)
  return event
}

/** The journal is the lock inode and is never replaced; acknowledged appends are fsynced. */
async function appendSubmission(
  path: string,
  event: ChoiceAuditEvent,
  inventory: readonly ObjectRef[],
): Promise<void> {
  await withAdvisoryFileLock(path, 1000, async () => {
    const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_DRAFT_BYTES)
        throw new Error('invalid journal')
      const raw = Buffer.alloc(before.size)
      let offset = 0
      while (offset < raw.length) {
        const read = await handle.read(raw, offset, raw.length - offset, offset)
        if (read.bytesRead === 0) throw new Error('journal changed')
        offset += read.bytesRead
      }
      const prior = readAuditDraft(raw, inventory, draftReviewId)
      if (!Buffer.from(prior.submissions).equals(raw)) throw new Error('journal is corrupt')
      const events =
        raw.length === 0
          ? []
          : raw
              .toString('utf8')
              .trimEnd()
              .split('\n')
              .map(line => JSON.parse(line))
      const encoded = canonicalJson(event)
      const duplicate = events.some(value => canonicalJson(value) === encoded)
      if (!duplicate) {
        const next = acceptAuditDraft([...events, event], inventory, draftReviewId)
        const expected = Buffer.concat([raw, Buffer.from(encoded)])
        if (!Buffer.from(next.submissions).equals(expected))
          throw new Error(next.rejections.at(-1) ?? 'submission rejected')
      }
      const current = await lstat(path)
      if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size)
        throw new Error('journal changed')
      let written = 0
      const bytes = Buffer.from(duplicate ? '' : encoded)
      while (written < bytes.length) {
        const result = await handle.write(
          bytes,
          written,
          bytes.length - written,
          before.size + written,
        )
        if (result.bytesWritten === 0) throw new Error('journal append stalled')
        written += result.bytesWritten
      }
      await handle.sync()
      const directory = await open(
        dirname(path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } finally {
      await handle.close()
    }
  })
}

async function respond(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(value) + '\n', error =>
      error ? reject(error) : resolve(),
    ),
  )
}

function submissionError(error: unknown): string {
  const messages: Readonly<Record<string, string>> = {
    'choice requires correctedDecision': 'Unsound choices require correctedDecision.',
    'choice requires provisionalCall': 'Needs-user choices require provisionalCall and reversal.',
    'choice requires reversal': 'Needs-user choices require reversal.',
    'unknown evidence handle': 'Use an exact evidenceId from this bundle evidenceIndex.',
    'unknown citation': 'The citation must resolve to an exact bundle object.',
    'conflicting choice key':
      'This choice key already has a different submission; exact retries only.',
    'conflicting summary': 'The audit already has a different scope summary; exact retries only.',
    'unfinished audit':
      'Finish requires a cited scope summary and, with no choices, noChoiceRationale.',
    'audit is finished': 'The audit is finished; only exact retries are accepted.',
    'choice limit': 'The audit has reached its choice limit.',
    'ledger byte limit': 'The audit has reached its durable ledger byte limit.',
    'draft byte limit': 'The audit has reached its submission byte limit.',
    'journal is corrupt':
      'The submission journal is invalid; this attempt cannot accept more events.',
  }
  return error instanceof Error && Object.hasOwn(messages, error.message)
    ? messages[error.message]!
    : 'Submission rejected. Match the tool schema, verdict-specific fields, citation handles, and documented byte limits.'
}

/** Fixed stdio MCP surface: no network, dynamic registrations, or provider configuration reads. */
export async function serveAuditSubmissions(args: readonly string[]): Promise<void> {
  const [bundlePath, bundleSha256, outputPath] = args
  if (
    args.length !== 3 ||
    !bundlePath ||
    !bundleSha256 ||
    !outputPath ||
    basename(outputPath) !== 'submissions.jsonl'
  )
    throw new Error('invalid server arguments')
  const verified = await verifyBundle(bundlePath, bundleSha256)
  if (!verified.valid || verified.manifest.plan.status !== 'ready')
    throw new Error('invalid bundle')
  const inventory = verified.manifest.inventory
  const evidence = new Map(
    verified.manifest.evidenceIndex.map(entry => [entry.evidenceId, entry.object]),
  )
  let initialized = false
  let ready = false
  let messages = 0
  let pending = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, Buffer.from(chunk)])
    let end: number
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > MAX_MESSAGE_BYTES || ++messages > 4096) throw new Error('protocol bound exceeded')
      const line = pending.subarray(0, end)
      pending = pending.subarray(end + 1)
      let request: unknown
      try {
        request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
      } catch {
        await respond({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid JSON message.' },
        })
        continue
      }
      if (
        !record(request) ||
        request.jsonrpc !== '2.0' ||
        typeof request.method !== 'string' ||
        ('id' in request &&
          !(
            (typeof request.id === 'number' && Number.isSafeInteger(request.id)) ||
            (typeof request.id === 'string' && request.id.length <= 128)
          ))
      ) {
        await respond({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid request.' },
        })
        continue
      }
      if (!('id' in request)) {
        if (request.method === 'notifications/initialized' && initialized) ready = true
        continue
      }
      const answer = (result: unknown) => respond({ jsonrpc: '2.0', id: request.id, result })
      const error = (code: number, message: string) =>
        respond({ jsonrpc: '2.0', id: request.id, error: { code, message } })
      if (
        request.method === 'initialize' &&
        !initialized &&
        record(request.params) &&
        typeof request.params.protocolVersion === 'string' &&
        record(request.params.capabilities) &&
        record(request.params.clientInfo)
      ) {
        initialized = true
        await answer({
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'factory-choice-audit', version: '1' },
        })
      } else if (request.method === 'ping') await answer({})
      else if (!ready) await error(-32000, 'Initialize the audit server first.')
      else if (request.method === 'tools/list') await answer({ tools })
      else if (
        request.method === 'tools/call' &&
        record(request.params) &&
        toolNames.includes(request.params.name as (typeof toolNames)[number])
      ) {
        try {
          const event = resolveEvent(
            request.params.name as string,
            request.params.arguments ?? {},
            evidence,
          )
          await appendSubmission(outputPath, event, inventory)
          await answer({
            content: [{ type: 'text', text: 'Audit submission recorded.' }],
            isError: false,
          })
        } catch (error) {
          await answer({
            content: [
              {
                type: 'text',
                text: submissionError(error),
              },
            ],
            isError: true,
          })
        }
      } else await error(-32601, 'Unsupported audit method or tool.')
    }
    if (pending.length > MAX_MESSAGE_BYTES) throw new Error('protocol bound exceeded')
  }
  if (pending.length !== 0) throw new Error('incomplete protocol message')
}
