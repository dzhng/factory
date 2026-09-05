import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { assertVerifiedRelease, verifyReleaseArtifact } from '../src/release-manifest'
import { releaseFixture } from './release-fixture'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('release artifact verification', () => {
  test('mints a verified release only from the exact allowlisted archive', async () => {
    const value = await releaseFixture()
    const verified = await verifyReleaseArtifact({
      ...value,
      expectedTarget: value.identity.target,
    })
    expect(verified.version).toBe(value.identity.version)
    expect(verified.executableSha256).toBe(digest(verified.executable))
    const exposed = verified.executable
    exposed[0] = 0
    expect(verified.executable[0]).not.toBe(0)
    expect(() => assertVerifiedRelease({ ...verified, executable: verified.executable })).toThrow(
      'verified release capability',
    )
  })

  test('rejects extra content even when the transport digest covers it', async () => {
    const value = await releaseFixture({ extra: { 'credentials.json': 'secret' } })
    expect(
      verifyReleaseArtifact({ ...value, expectedTarget: value.identity.target }),
    ).rejects.toThrow('content is not allowlisted')
  })

  test('rejects the right bytes for the wrong platform', async () => {
    const value = await releaseFixture()
    expect(
      verifyReleaseArtifact({ ...value, expectedTarget: 'bun-linux-x64-baseline' }),
    ).rejects.toThrow('target mismatch')
  })

  test('rejects a manifest that lacks the caller trusted digest', async () => {
    const value = await releaseFixture()
    expect(
      verifyReleaseArtifact({
        ...value,
        expectedManifestSha256: '0'.repeat(64),
        expectedTarget: value.identity.target,
      }),
    ).rejects.toThrow('trusted release manifest digest mismatch')
  })

  test('rejects package-shaped JSON without an SPDX document identity', async () => {
    const value = await releaseFixture({ validSbom: false })
    expect(
      verifyReleaseArtifact({ ...value, expectedTarget: value.identity.target }),
    ).rejects.toThrow('release SBOM')
  })
})
