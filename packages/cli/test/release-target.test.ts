import { expect, test } from 'bun:test'

import { releaseTargetForCurrentHost } from '../src/installation'

if (
  process.env.FACTORY_DOCKER_TEST !== '1' ||
  process.platform !== 'linux' ||
  process.arch !== 'x64'
) {
  throw new Error('release target test requires Linux x64 Docker')
}

test('claims the Linux release target only on glibc', () => {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: unknown } }
    | undefined
  expect(releaseTargetForCurrentHost()).toBe(
    typeof report?.header?.glibcVersionRuntime === 'string' ? 'bun-linux-x64-baseline' : undefined,
  )
})
