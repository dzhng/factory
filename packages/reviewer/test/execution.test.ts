import { describe, expect, test } from 'bun:test'

import { reviewerExecutionFailureTermination } from '../src/execution'
import { ReviewerDockerUnavailableError } from '../src/probe'
import { reviewerImageIdentity } from '../src/probe'

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

describe('reviewer image identity', () => {
  const digest = `sha256:${'b'.repeat(64)}`

  test('accepts local image IDs and digest-qualified repository references', () => {
    expect(reviewerImageIdentity(digest)).toEqual({ digest, remote: false })
    expect(reviewerImageIdentity(`ghcr.io/dzhng/factory-reviewer@${digest}`)).toEqual({
      digest,
      remote: true,
    })
  })

  test('refuses mutable, malformed, and mismatched identity syntax', () => {
    for (const reference of [
      'ghcr.io/dzhng/factory-reviewer:main',
      `ghcr.io/dzhng/factory-reviewer:${digest}`,
      `GHCR.IO/dzhng/factory-reviewer@${digest}`,
      `ghcr.io/dzhng/factory reviewer@${digest}`,
    ]) {
      expect(() => reviewerImageIdentity(reference)).toThrow('digest-qualified')
    }
  })
})
