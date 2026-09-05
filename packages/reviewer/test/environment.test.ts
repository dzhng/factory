import { describe, expect, test } from 'bun:test'

import { inspectReviewerEnvironment, type ReviewerCommandResult } from '../src/index'

const bytes = (value: string) => Buffer.from(value)
type DockerUnavailableReason =
  | 'missing'
  | 'timeout'
  | 'output-limit'
  | 'command-failed'
  | 'malformed-response'

describe('reviewer environment inspection', () => {
  test('reports the bounded Docker server version and unconfigured authentication', async () => {
    const inspection = await inspectReviewerEnvironment(
      {},
      async () => ({
        kind: 'completed',
        exitCode: 0,
        stdout: bytes('27.5.1\n'),
        stderr: bytes(''),
      }),
      { platform: 'linux' },
    )
    expect(inspection).toEqual({
      docker: { availability: 'available', version: '27.5.1' },
      credentials: { codex: { state: 'unconfigured' }, claude: { state: 'unconfigured' } },
    })
  })

  test('keeps Docker failure classes explicit', async () => {
    const scenarios: [ReviewerCommandResult, DockerUnavailableReason][] = [
      [{ kind: 'missing', stdout: bytes(''), stderr: bytes('') }, 'missing'],
      [{ kind: 'timeout', stdout: bytes(''), stderr: bytes('') }, 'timeout'],
      [{ kind: 'output-limit', stdout: bytes(''), stderr: bytes('') }, 'output-limit'],
      [
        { kind: 'completed', exitCode: 1, stdout: bytes(''), stderr: bytes('offline') },
        'command-failed',
      ],
      [
        { kind: 'completed', exitCode: 0, stdout: bytes('\n'), stderr: bytes('') },
        'malformed-response',
      ],
    ]
    for (const [result, reason] of scenarios) {
      expect((await inspectReviewerEnvironment({}, async () => result)).docker).toEqual({
        availability: 'unavailable',
        reason,
      })
    }
  })
})
