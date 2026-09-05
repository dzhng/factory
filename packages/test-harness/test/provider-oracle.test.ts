import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  buildProviderOracle,
  type TranscriptObservation,
  writeProviderOracle,
} from '../src/provider-oracle'

describe('provider reference oracle', () => {
  test('preserves every fixture byte and reports provider-native identities', async () => {
    const report = await buildProviderOracle()

    expect(report.probes.map(({ provider }) => provider)).toEqual(['codex', 'claude'])
    for (const probe of report.probes) {
      expect(probe.rawEvents.every(({ roundTripsExactly }) => roundTripsExactly)).toBeTrue()
      expect(probe.unknownBytesPreserved).toBeTrue()
      expect(probe.sessionIdentity.status).toBe('supported')
      expect(probe.stopIdentity.status).toBe('supported')
    }
  })

  test('classifies every donor transcript transition without erasing prior versions', async () => {
    const report = await buildProviderOracle()
    const expected: Array<TranscriptObservation['relation']> = [
      'initial',
      'append',
      'replacement',
      'truncation',
      'replacement',
      'compaction',
      undefined,
    ]

    for (const probe of report.probes) {
      expect(probe.transcriptObservations.map(({ relation }) => relation)).toEqual(expected)
      expect(probe.transcriptObservations.at(-1)).toEqual({
        event: 'SessionEnd',
        status: 'unavailable',
        reason: 'deleted',
      })
      expect(probe.transcriptObservations.slice(0, -1).every(({ sha256 }) => sha256)).toBeTrue()
      expect(probe.limitations).toContainEqual(
        expect.objectContaining({ code: 'stop-transcript-may-lag' }),
      )
    }
  })

  test('distinguishes certified client help from unavailable authenticated evidence', async () => {
    const report = await buildProviderOracle()

    expect(report.clientInventory.environment).toEqual('credential-free-docker')
    expect(
      report.clientInventory.clients.map(({ provider, versionStatus }) => [
        provider,
        versionStatus,
      ]),
    ).toEqual([
      ['codex', 'certified'],
      ['claude', 'certified'],
    ])
    expect(report.clientInventory.dockerCertification.status).toBe('supported')
    for (const probe of report.probes) {
      expect(probe.limitations).toContainEqual(
        expect.objectContaining({ code: 'authenticated-live-capture-unavailable' }),
      )
    }
  })

  test('reproduces cross-process sequencing and fail-open hook responses', async () => {
    const report = await buildProviderOracle()

    expect(report.processProbe.environment).toBe('credential-free-docker')
    expect(report.processProbe.sequencing).toEqual({
      workers: 8,
      recordsPerWorker: 25,
      observed: 200,
      contiguous: true,
      unique: true,
    })
    expect(report.processProbe.hookResponses).toEqual([
      { provider: 'codex', outcome: 'captured', exitCode: 0, stdout: '{}\n' },
      { provider: 'codex', outcome: 'capture-failed', exitCode: 0, stdout: '{}\n' },
      { provider: 'claude', outcome: 'captured', exitCode: 0, stdout: '{}\n' },
      { provider: 'claude', outcome: 'capture-failed', exitCode: 0, stdout: '{}\n' },
    ])
  })

  test('writes linked JSON and readable HTML without credentials or host paths', async () => {
    const output = await mkdtemp(`${tmpdir()}/factory-provider-oracle-`)
    try {
      await writeProviderOracle(output)
      const json = await readFile(`${output}/report.json`, 'utf8')
      const html = await readFile(`${output}/index.html`, 'utf8')

      expect(
        JSON.parse(json).donorReferences.map(
          ({ disposition }: { disposition: string }) => disposition,
        ),
      ).toEqual(
        expect.arrayContaining([
          'port-candidate',
          'rewrite',
          'negative-reference',
          'hosted-only-delete',
        ]),
      )
      expect(html).toContain('Provider capture oracle')
      expect(html).toContain(
        '../../../../packages/test-harness/fixtures/providers/codex/hooks.jsonl',
      )
      for (const artifact of [json, html]) {
        expect(artifact).not.toMatch(/\/(?:Users|home)\//)
        expect(artifact).not.toMatch(
          /(?:api[_-]?key|access[_-]?token|authorization)["'=:\s]+[^\s<&]+/i,
        )
      }
    } finally {
      await rm(output, { recursive: true })
    }
  })

  test('keeps callback order provider-native and marks current live inventories unavailable', async () => {
    const report = await buildProviderOracle()

    for (const probe of report.probes) {
      expect(probe.fixtureEventOrder.indexOf('Stop')).toBeGreaterThan(
        probe.fixtureEventOrder.indexOf('PostToolUse'),
      )
      expect(probe.currentEventInventory.status).toBe('unavailable')
    }
    expect(report.probes[0]?.fixtureEventOrder).not.toEqual(report.probes[1]?.fixtureEventOrder)
  })
})
