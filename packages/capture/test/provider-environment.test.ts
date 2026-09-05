import { describe, expect, test } from 'bun:test'

import {
  inspectCaptureProviderEnvironment,
  type ProviderCommandResult,
} from '../src/provider-environment'

const bytes = (value: string) => Buffer.from(value)

describe('capture provider environment inspection', () => {
  test('reports provider-owned versions', async () => {
    expect(
      await inspectCaptureProviderEnvironment(
        {},
        {
          run: async provider => ({
            kind: 'completed',
            exitCode: 0,
            stdout: bytes(`${provider} 1.2.3\n`),
            stderr: bytes(''),
          }),
        },
      ),
    ).toEqual({
      codex: { availability: 'available', version: 'codex 1.2.3' },
      claude: { availability: 'available', version: 'claude 1.2.3' },
    })
  })

  test('keeps command and malformed-output failures explicit', async () => {
    const results: Record<'codex' | 'claude', ProviderCommandResult> = {
      codex: { kind: 'missing', stdout: bytes(''), stderr: bytes('') },
      claude: { kind: 'completed', exitCode: 0, stdout: bytes('other 1.0\n'), stderr: bytes('') },
    }
    expect(
      await inspectCaptureProviderEnvironment({}, { run: async provider => results[provider] }),
    ).toEqual({
      codex: { availability: 'unavailable', reason: 'missing' },
      claude: { availability: 'available', version: 'other 1.0' },
    })
  })
})
