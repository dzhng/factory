import { randomBytes } from 'node:crypto'

import type { RecordId, Sha256 } from '@factory/contract'
import type { UiSnapshot } from '@factory/domain'

import { CLIENT, SHELL, STYLES } from './assets'

export type UiDecisionAction =
  | {
      schemaVersion: 1
      actionId: RecordId
      kind: 'confirm' | 'reject' | 'dispute'
      targetObservationId: RecordId
      actor: { kind: 'human'; label: string }
      expectedStateFingerprint: Sha256
      note?: string
    }
  | {
      schemaVersion: 1
      actionId: RecordId
      kind: 'resolve'
      disputeActionId: RecordId
      actor: { kind: 'human'; label: string }
      expectedStateFingerprint: Sha256
      note: string
    }
  | {
      schemaVersion: 1
      actionId: RecordId
      kind: 'supersede'
      fromObservationId: RecordId
      toObservationId: RecordId
      actor: { kind: 'human'; label: string }
      expectedStateFingerprint: Sha256
      note: string
    }

export type ActionPort = {
  appendDecision(action: UiDecisionAction): Promise<unknown>
  acceptCoverage(reviewId: RecordId): Promise<unknown>
}

export type ServeLocalUiInput = {
  host: '127.0.0.1'
  port?: number
  snapshot(): Promise<UiSnapshot>
  actions: ActionPort
}

export type LocalUiHandle = {
  hostname: '127.0.0.1'
  port: number
  origin: string
  finished: Promise<void>
  stop(): Promise<void>
}

export class UiActionConflictError extends Error {
  constructor() {
    super('action is stale')
    this.name = 'UiActionConflictError'
  }
}

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const

function response(body: string | null, status: number, contentType: string): Response {
  return new Response(body, {
    status,
    headers: { ...securityHeaders, 'Content-Type': contentType },
  })
}

function json(value: unknown, status = 200): Response {
  return response(JSON.stringify(value), status, 'application/json; charset=utf-8')
}

function error(code: string, status: number): Response {
  return json({ error: code }, status)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  )
}

function isRecordId(value: unknown): value is RecordId {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function note(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2_000)
    throw new TypeError('invalid note')
  return value
}

function parseDecision(value: unknown): UiDecisionAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('invalid action')
  const input = value as Record<string, unknown>
  if (!isRecordId(input.actionId) || !isSha256(input.expectedStateFingerprint))
    throw new TypeError('invalid action authority')
  if (!['confirm', 'reject', 'dispute', 'resolve', 'supersede'].includes(String(input.kind)))
    throw new TypeError('invalid action kind')
  const base = {
    schemaVersion: 1 as const,
    actionId: input.actionId,
    actor: { kind: 'human' as const, label: 'factory open' },
    expectedStateFingerprint: input.expectedStateFingerprint,
  }
  if (input.kind === 'confirm' || input.kind === 'reject' || input.kind === 'dispute') {
    const keys = ['actionId', 'expectedStateFingerprint', 'kind', 'targetObservationId']
    if (input.note !== undefined) keys.push('note')
    if (!exactKeys(input, keys) || !isRecordId(input.targetObservationId))
      throw new TypeError('invalid observation action')
    const actionNote = note(input.note, input.kind === 'dispute')
    return {
      ...base,
      kind: input.kind,
      targetObservationId: input.targetObservationId,
      ...(actionNote === undefined ? {} : { note: actionNote }),
    }
  }
  if (input.kind === 'resolve') {
    if (
      !exactKeys(input, [
        'actionId',
        'disputeActionId',
        'expectedStateFingerprint',
        'kind',
        'note',
      ]) ||
      !isRecordId(input.disputeActionId)
    )
      throw new TypeError('invalid resolve action')
    return {
      ...base,
      kind: 'resolve',
      disputeActionId: input.disputeActionId,
      note: note(input.note, true)!,
    }
  }
  if (
    !exactKeys(input, [
      'actionId',
      'expectedStateFingerprint',
      'fromObservationId',
      'kind',
      'note',
      'toObservationId',
    ]) ||
    !isRecordId(input.fromObservationId) ||
    !isRecordId(input.toObservationId)
  )
    throw new TypeError('invalid supersede action')
  return {
    ...base,
    kind: 'supersede',
    fromObservationId: input.fromObservationId,
    toObservationId: input.toObservationId,
    note: note(input.note, true)!,
  }
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('unsupported-media')
  const length = request.headers.get('content-length')
  if (length !== null && Number(length) > 16 * 1024) throw new RangeError('body-too-large')
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > 16 * 1024) throw new RangeError('body-too-large')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

export async function serveLocalUi(input: ServeLocalUiInput): Promise<LocalUiHandle> {
  if (input.host !== '127.0.0.1') throw new TypeError('Factory UI requires IPv4 loopback')
  const csrfToken = randomBytes(32).toString('base64url')
  let expectedHost = ''
  let origin = ''
  let finish!: () => void
  let stopped = false
  const finished = new Promise<void>(resolve => {
    finish = resolve
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: input.port ?? 0,
    development: false,
    reusePort: false,
    idleTimeout: 10,
    maxRequestBodySize: 16 * 1024,
    async fetch(request) {
      if (request.headers.get('host') !== expectedHost) return error('invalid-host', 421)
      const url = new URL(request.url)
      const method = request.method.toUpperCase()
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST')
        return error('method-not-allowed', 405)
      if (method === 'GET' || method === 'HEAD') {
        let result: Response
        if (url.pathname === '/') result = response(SHELL, 200, 'text/html; charset=utf-8')
        else if (url.pathname === '/assets/app.css')
          result = response(STYLES, 200, 'text/css; charset=utf-8')
        else if (url.pathname === '/assets/app.js')
          result = response(CLIENT, 200, 'text/javascript; charset=utf-8')
        else if (url.pathname === '/api/session') result = json({ csrfToken })
        else if (url.pathname === '/api/snapshot') {
          try {
            const snapshot = await input.snapshot()
            const encoded = JSON.stringify(snapshot)
            result =
              new TextEncoder().encode(encoded).byteLength > 8 * 1024 * 1024
                ? error('snapshot-too-large', 413)
                : response(encoded, 200, 'application/json; charset=utf-8')
          } catch {
            result = error('snapshot-unavailable', 500)
          }
        } else result = error('not-found', 404)
        return method === 'HEAD'
          ? new Response(null, { status: result.status, headers: result.headers })
          : result
      }
      if (!url.pathname.startsWith('/api/actions/')) return error('not-found', 404)
      if (
        request.headers.get('origin') !== origin ||
        request.headers.get('x-factory-csrf') !== csrfToken
      )
        return error('request-authority-rejected', 403)
      try {
        const snapshot = await input.snapshot()
        if (snapshot.state !== 'ready') return error('repository-unavailable', 409)
        const body = await readJson(request)
        if (url.pathname === '/api/actions/decision') {
          await input.actions.appendDecision(parseDecision(body))
        } else if (url.pathname === '/api/actions/coverage') {
          if (
            body === null ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            !exactKeys(body as Record<string, unknown>, ['reviewId']) ||
            !isRecordId((body as Record<string, unknown>).reviewId)
          )
            throw new TypeError('invalid coverage action')
          await input.actions.acceptCoverage((body as { reviewId: RecordId }).reviewId)
        } else return error('not-found', 404)
        return json({ ok: true }, 201)
      } catch (cause) {
        if (cause instanceof UiActionConflictError) return error('stale-action', 409)
        if (cause instanceof RangeError && cause.message === 'body-too-large')
          return error('body-too-large', 413)
        if (cause instanceof TypeError && cause.message === 'unsupported-media')
          return error('unsupported-media', 415)
        if (cause instanceof SyntaxError || cause instanceof TypeError)
          return error('invalid-action', 400)
        return error('action-failed', 500)
      }
    },
  })
  const port = server.port
  if (port === undefined) {
    await server.stop(true)
    throw new Error('Factory UI server did not report its bound port')
  }
  expectedHost = `127.0.0.1:${port}`
  origin = `http://${expectedHost}`
  return {
    hostname: '127.0.0.1',
    port,
    origin,
    finished,
    async stop() {
      if (stopped) return
      stopped = true
      await server.stop(true)
      finish()
    },
  }
}
