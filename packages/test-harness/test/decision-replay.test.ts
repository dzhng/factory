import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { buildDecisionReplay, writeDecisionReplay } from '../src/decision-replay'

describe('canonical decision replay', () => {
  test('explains every observable lifecycle transition', () => {
    const report = buildDecisionReplay()

    expect(
      report.steps.map(step => [
        step.name,
        step.focus.lifecycle,
        step.focus.humanStatus,
        step.focus.priority,
        step.focus.pendingReason ?? null,
      ]),
    ).toEqual([
      ['feature proposal', 'proposal', 'unconfirmed', 'normal', null],
      ['first canonical observation', 'canonical-current', 'unconfirmed', 'normal', null],
      ['unchanged canonical replay', 'canonical-replay', 'unconfirmed', 'normal', null],
      ['canonical change', 'pending-supersession', 'unconfirmed', 'high', 'change'],
      ['canonical removal', 'pending-supersession', 'unconfirmed', 'high', 'removal'],
      ['canonical contradiction', 'pending-supersession', 'unconfirmed', 'high', 'contradiction'],
      ['human confirmation', 'canonical-current', 'confirmed', 'normal', null],
      ['proposal rejection', 'rejected', 'unconfirmed', 'normal', null],
      ['human dispute', 'canonical-current', 'disputed', 'high', null],
      ['dispute resolution', 'canonical-current', 'confirmed', 'normal', null],
      ['explicit supersession', 'canonical-current', 'unconfirmed', 'normal', null],
    ])
    expect(report.determinism).toEqual({ shuffledInputsMatch: true })
  })

  test('writes deterministic machine-readable and human-readable reports', async () => {
    const output = await mkdtemp(`${tmpdir()}/factory-decision-replay-`)
    try {
      const first = await writeDecisionReplay(output)
      const firstJson = await readFile(`${output}/report.json`, 'utf8')
      const firstHtml = await readFile(`${output}/index.html`, 'utf8')
      const second = await writeDecisionReplay(output)

      expect(second).toEqual(first)
      expect(await readFile(`${output}/report.json`, 'utf8')).toBe(firstJson)
      expect(firstHtml).toContain('Canonical decision replay')
      expect(firstHtml).toContain('canonical change')
      expect(firstHtml).toContain('exact semantic fingerprint changed')
      expect(firstHtml).toContain('canonical contradiction')
      expect(firstHtml).toContain('explicit contradiction')
    } finally {
      await rm(output, { recursive: true })
    }
  })
})
