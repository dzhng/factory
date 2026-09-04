import { describe, expect, test } from 'bun:test'

import { resolveConfiguration, suggestCanonicalBranch } from '../src/index'

describe('capture configuration', () => {
  test('resolves flags before repository, global, and defaults', () => {
    expect(
      resolveConfiguration(
        { automaticReview: false },
        { automaticReview: true, canonicalBranch: 'repo' },
        {
          automaticReview: false,
          canonicalBranch: 'global',
          repositoryInitialization: 'automatic',
        },
      ),
    ).toEqual({
      automaticReview: false,
      canonicalBranch: 'repo',
      repositoryInitialization: 'automatic',
      reviewer: 'auto',
    })
  })

  test('undefined values do not erase lower-precedence configuration', () => {
    expect(
      resolveConfiguration(
        { automaticReview: undefined },
        { automaticReview: true },
        { repositoryInitialization: 'automatic' },
      ),
    ).toEqual({
      automaticReview: true,
      repositoryInitialization: 'automatic',
      reviewer: 'auto',
    })
  })

  test('uses authenticated gh before local fallbacks and preserves explicit override', async () => {
    const discovered = await suggestCanonicalBranch({
      gh: async () => 'trunk',
      remoteHead: async () => 'remote-main',
      localBranches: async () => ['main'],
    })
    expect(discovered).toEqual({ branch: 'trunk', source: 'github' })
    expect(
      await suggestCanonicalBranch(
        {
          gh: async () => 'trunk',
          remoteHead: async () => 'remote-main',
          localBranches: async () => ['main'],
        },
        'release',
      ),
    ).toEqual({ branch: 'release', source: 'explicit' })
  })
})
