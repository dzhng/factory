import { describe, expect, test } from 'bun:test'

import { reviewerExecutionFailureTermination } from '../src/execution'
import { ReviewerDockerUnavailableError } from '../src/probe'

describe('review execution failure classification', () => {
  test('distinguishes Docker setup failures from provider crashes', () => {
    expect(
      reviewerExecutionFailureTermination(
        new ReviewerDockerUnavailableError('Docker image is unavailable'),
      ),
    ).toBe('docker-unavailable')
    expect(
      reviewerExecutionFailureTermination(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    ).toBe('docker-unavailable')
    expect(reviewerExecutionFailureTermination(new Error('provider exited'))).toBe('crashed')
  })
})
