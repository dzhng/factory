#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const input = args[0] === 'capture' ? await Bun.stdin.bytes() : undefined
const child = Bun.spawn(['bun', '/opt/factory/factory.js', ...args], {
  stdin: input === undefined ? 'ignore' : new Blob([input]),
  stdout: 'pipe',
  stderr: 'pipe',
})
const [code, stdout, stderr] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
])
if (input !== undefined) {
  const row = JSON.parse(new TextDecoder().decode(input))
  const transcript =
    typeof row.transcript_path === 'string'
      ? await readFile(row.transcript_path).catch(() => undefined)
      : undefined
  await appendFile(
    '/tmp/capture-callbacks.jsonl',
    `${JSON.stringify({
      phase: process.env.FACTORY_CAPTURE_PROBE_PHASE ?? 'capture',
      event: row.hook_event_name,
      sessionId: row.session_id,
      stopId: row.turn_id ?? row.prompt_id ?? null,
      rawSha256: createHash('sha256').update(input).digest('hex'),
      transcriptBytes: transcript?.length ?? 0,
      code,
      stdout,
    })}\n`,
  )
}
process.stdout.write(stdout)
process.stderr.write(stderr)
process.exitCode = code
