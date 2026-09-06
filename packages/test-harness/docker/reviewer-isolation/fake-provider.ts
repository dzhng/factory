#!/usr/bin/env bun
import { writeFile } from 'node:fs/promises'
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
const events: unknown[] = []
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
// The independent fake provider emits the same canonical JSON that the submission server will own.
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, ordered(item)]),
        )
      : value
const submissions = events.map(event => JSON.stringify(ordered(event)) + '\n').join('')
await writeFile(
  '/out/submissions.jsonl',
  behavior.includes('factory-test-oversized') ? submissions.repeat(20_000) : submissions,
)
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
    !process.argv.includes('--safe-mode') ||
    !process.argv.includes('--restricted') ||
    !process.argv.includes('--no-session-persistence') ||
    !process.argv.includes('/review-input') ||
    process.env.CLAUDE_CONFIG_DIR !== '/auth/claude'
  )
    throw new Error('Claude adapter invocation differs from the pinned contract')
  process.stdout.write(
    behavior.includes('factory-test-oversized') ? response.repeat(40_000) : response,
  )
  if (behavior.includes('factory-test-prefix-timeout')) await new Promise(() => undefined)
  if (behavior.includes('factory-test-prefix-nonzero')) process.exit(7)
}
