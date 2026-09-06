import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

type CommandResult = { code: number; stdout: string; stderr: string }
const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000
const COMMAND_OUTPUT_LIMIT = 8 * 1024 * 1024

export async function command(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: environment,
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const readBounded = async (stream: ReadableStream<Uint8Array>, name: string) => {
    let size = 0
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) {
      size += chunk.byteLength
      if (size > COMMAND_OUTPUT_LIMIT) throw new Error(`${name} exceeded its output bound`)
      chunks.push(chunk.slice())
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [code, stdout, stderr] = await Promise.race([
      Promise.all([
        child.exited,
        readBounded(child.stdout, 'stdout'),
        readBounded(child.stderr, 'stderr'),
      ]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('certification command timed out')),
          COMMAND_TIMEOUT_MS,
        )
      }),
    ])
    return { code, stdout, stderr }
  } catch (error) {
    child.kill(9)
    await child.exited.catch(() => undefined)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function succeed(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<CommandResult> {
  const result = await command(executable, args, cwd, environment, stdin)
  if (result.code !== 0)
    throw new Error(`${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result
}

export async function replayProvider(
  provider: 'codex' | 'claude',
  executable: string,
  repository: string,
  home: string,
  environment: NodeJS.ProcessEnv,
  options: {
    continuing?: boolean
    fixtureRoot?: string
    assistantMessage?: string
    deliverStop?: (deliver: () => Promise<void>) => Promise<void>
  } = {},
): Promise<void> {
  const {
    continuing = false,
    fixtureRoot = resolve(import.meta.dir, '../fixtures/providers', provider),
    assistantMessage = 'Stale transcript answer.',
  } = options
  const transcript = join(
    home,
    provider === 'codex'
      ? '.codex/sessions/certification.jsonl'
      : '.claude/projects/certification.jsonl',
  )
  await mkdir(dirname(transcript), { recursive: true })
  if (continuing) {
    assert.equal(provider, 'codex', 'the resumed release fixture uses Codex native Turn IDs')
    const previous = await readFile(transcript, 'utf8')
    const fixture = await readFile(join(fixtureRoot, 'transcript.jsonl'), 'utf8')
    await writeFile(
      transcript,
      previous +
        fixture
          .slice(fixture.indexOf('\n') + 1)
          .replaceAll('turn-1', 'turn-2')
          .replaceAll('tool-1', 'tool-2'),
    )
  } else await cp(join(fixtureRoot, 'transcript.jsonl'), transcript)
  const rows = (await readFile(join(fixtureRoot, 'hooks.jsonl'), 'utf8'))
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const config = JSON.parse(
    await readFile(
      provider === 'codex'
        ? join(home, '.codex', 'hooks.json')
        : join(home, '.claude', 'settings.json'),
      'utf8',
    ),
  )
  for (const row of rows.filter(value =>
    [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ].includes(String(value.hook_event_name)),
  )) {
    if (continuing && row.hook_event_name === 'SessionEnd') continue
    if (continuing) {
      if (row.hook_event_name === 'SessionStart') row.event_id = 'resume-2'
      if (row.turn_id !== undefined) row.turn_id = 'turn-2'
      if (row.tool_use_id !== undefined) row.tool_use_id = 'tool-2'
    }
    row.cwd = repository
    if (row.transcript_path !== undefined) row.transcript_path = transcript
    if (row.last_assistant_message !== undefined) row.last_assistant_message = assistantMessage
    const hook = config.hooks[String(row.hook_event_name)].at(-1).hooks[0]
    const deliver = async () => {
      const result =
        provider === 'codex'
          ? await command(
              '/bin/sh',
              ['-c', hook.command],
              repository,
              environment,
              `${JSON.stringify(row)}\n`,
            )
          : await command(
              hook.command,
              hook.args,
              repository,
              environment,
              `${JSON.stringify(row)}\n`,
            )
      if (result.code !== 0 || result.stdout !== '{}\n')
        throw new Error(`${provider} installed hook failed through ${executable}`)
    }
    if (row.hook_event_name === 'Stop' && options.deliverStop !== undefined)
      await options.deliverStop(deliver)
    else await deliver()
  }
}

export async function openAndConfirmDecision(
  executable: string,
  repository: string,
  environment: NodeJS.ProcessEnv,
  options: {
    note?: string
    acceptCoverageReviewId?: string
    beforeDecisionRetry?: () => Promise<void>
  } = {},
): Promise<void> {
  const child = Bun.spawn([executable, 'open'], {
    cwd: repository,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  try {
    let output = ''
    let origin: string | undefined
    const deadline = Date.now() + 10_000
    while (origin === undefined && Date.now() < deadline) {
      const remaining = deadline - Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('factory open startup timed out')), remaining)
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      if (next.done) break
      output += new TextDecoder().decode(next.value)
      if (Buffer.byteLength(output) > 64 * 1024)
        throw new Error('factory open startup output exceeded its bound')
      origin = output.split('\n').find(line => /^http:\/\/127\.0\.0\.1:\d+$/.test(line))
    }
    if (origin === undefined) throw new Error('factory open did not publish its loopback origin')
    const signal = AbortSignal.timeout(5_000)
    const snapshot = (await (await fetch(`${origin}/api/snapshot`, { signal })).json()) as {
      state: string
      decisions: {
        stateFingerprint: string
        groups: {
          choices: { humanStatus: string; observation: { observationId: string } }[]
        }[]
      }
    }
    if (snapshot.state !== 'ready')
      throw new Error('factory open did not render a ready projection')
    const decision = snapshot.decisions.groups
      .flatMap(group => group.choices)
      .find(observation => observation.humanStatus === 'unconfirmed')
    if (decision === undefined) throw new Error('review decision was not visible in factory open')
    const session = (await (await fetch(`${origin}/api/session`, { signal })).json()) as {
      csrfToken: string
    }
    const request = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Factory-CSRF': session.csrfToken,
      },
      body: JSON.stringify({
        actionId: 'action_00000000000000000000000031',
        kind: 'confirm',
        ...(options.note === undefined ? {} : { note: options.note }),
        targetObservationId: decision.observation.observationId,
        expectedStateFingerprint: snapshot.decisions.stateFingerprint,
      }),
      signal,
    }
    const response = await fetch(`${origin}/api/actions/decision`, request)
    if (response.status !== 201) throw new Error('factory open rejected the decision action')
    if (options.beforeDecisionRetry !== undefined) {
      await options.beforeDecisionRetry()
      const retry = await fetch(`${origin}/api/actions/decision`, request)
      assert.equal(
        retry.status,
        201,
        'exact action retry must preserve its frozen semantics after env rotation',
      )
    }
    if (options.acceptCoverageReviewId !== undefined) {
      const coverage = await fetch(`${origin}/api/actions/coverage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          'X-Factory-CSRF': session.csrfToken,
        },
        body: JSON.stringify({ reviewId: options.acceptCoverageReviewId }),
        signal,
      })
      assert.equal(coverage.status, 201, 'localhost must accept the exact partial review')
    }
  } finally {
    child.kill()
    await child.exited.catch(() => undefined)
    reader.releaseLock()
  }
}
