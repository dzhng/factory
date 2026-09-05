#!/usr/bin/env bun
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const provider = basename(process.argv[1] ?? '')
if (process.argv.includes('--version')) {
  process.stdout.write(`${provider}-fake/1\n`)
  process.exit(0)
}

const prompt = await new Response(Bun.stdin.stream()).text()
if (!prompt.includes('/review-input') || !prompt.includes('newline-delimited JSON'))
  throw new Error('Factory review prompt was not delivered on stdin')
const bundle = (await Bun.file('/review-input/bundle.json').json()) as { inventory: unknown[] }
const authPath = provider === 'codex' ? '/auth/codex/auth.json' : '/auth/claude/.credentials.json'
const behavior = await Bun.file(authPath).text()
if (behavior.includes('factory-test-delay')) await Bun.sleep(1_500)
const response = `${JSON.stringify(
  behavior.includes('factory-test-high-finding')
    ? {
        kind: 'finding',
        severity: 'high',
        summary: 'Deterministic fake finding',
        evidence: [{ object: bundle.inventory[0] }],
      }
    : {
        kind: 'summary',
        summary: 'Deterministic fake review completed',
        evidence: [{ object: bundle.inventory[0] }],
      },
)}\n`
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
    behavior.includes('factory-test-oversized') ? response.repeat(20_000) : response,
  )
} else {
  if (
    !process.argv.includes('--safe-mode') ||
    !process.argv.includes('--restricted') ||
    !process.argv.includes('--no-session-persistence') ||
    !process.argv.includes('/review-input') ||
    process.env.CLAUDE_CONFIG_DIR !== '/auth/claude'
  )
    throw new Error('Claude adapter invocation differs from the pinned contract')
  process.stdout.write(
    behavior.includes('factory-test-oversized') ? response.repeat(20_000) : response,
  )
  if (behavior.includes('factory-test-prefix-timeout')) await new Promise(() => undefined)
  if (behavior.includes('factory-test-prefix-nonzero')) process.exit(7)
}
