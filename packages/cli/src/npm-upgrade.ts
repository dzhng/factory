import { realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { withInstallationLock } from './installation'
import { configRoot, readBoundedOrdinaryFile } from './private-files'

type NpmInstallation = { prefix: string; packageRoot: string }

/** Only the conventional npm global layout authorizes a global package mutation. */
export async function npmInstallation(executable: string): Promise<NpmInstallation | undefined> {
  const path = await realpath(executable)
  const packageRoot = resolve(dirname(path), '../..')
  const prefix = resolve(packageRoot, '../../../..')
  if (join(prefix, 'lib/node_modules/@dzhng/factory') !== packageRoot) return undefined
  if (
    !/^native\/(darwin-arm64|linux-x64-baseline)\/factory$/.test(path.slice(packageRoot.length + 1))
  )
    return undefined
  const bytes = await readBoundedOrdinaryFile(join(packageRoot, 'package.json'), 64 * 1024)
  if (!bytes || JSON.parse(new TextDecoder().decode(bytes)).name !== '@dzhng/factory')
    return undefined
  return { prefix, packageRoot }
}

function stableVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)
  )
}

async function latestVersion(): Promise<string> {
  const response = await fetch('https://registry.npmjs.org/@dzhng%2ffactory/latest', {
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  })
  if (!response.ok || !response.body) throw new Error('npm release discovery unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 64 * 1024) throw new Error('npm release metadata exceeds size bound')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!stableVersion(value.version)) throw new Error('npm latest is not a stable version')
  return value.version
}

export async function upgradeNpmInstallation(
  installation: NpmInstallation,
  environment: NodeJS.ProcessEnv,
  checkOnly: boolean,
  log: (message: string) => void,
  automatic = false,
): Promise<void> {
  await withInstallationLock(
    environment,
    async () => {
      // Never let npm invalidate the before/staged bytes of a pending native transaction.
      if (
        await readBoundedOrdinaryFile(
          join(configRoot(environment), 'installation-transaction.json'),
          1024 * 1024,
        )
      )
        throw new Error(
          'Pending Factory installation transaction; run factory doctor --repair first',
        )
      const manifestPath = join(installation.packageRoot, 'package.json')
      const bytes = await readBoundedOrdinaryFile(manifestPath, 64 * 1024)
      if (!bytes) throw new Error('Installed npm package is missing')
      const current = JSON.parse(new TextDecoder().decode(bytes)).version
      const latest = await latestVersion()
      if (!stableVersion(current)) throw new Error('Installed npm version is not stable')
      if (checkOnly) {
        log(`Latest stable Factory release: ${latest}. No update was installed.\n`)
        return
      }
      if (Bun.semver.order(current, latest) !== -1) {
        if (!automatic) log(`Factory ${current} is up to date.\n`)
        return
      }
      log(`Upgrading Factory ${current} → ${latest} with npm…\n`)
      const child = Bun.spawn(
        [
          'npm',
          'install',
          '--global',
          '--prefix',
          installation.prefix,
          '--registry=https://registry.npmjs.org',
          '--@dzhng:registry=https://registry.npmjs.org',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          `@dzhng/factory@${latest}`,
        ],
        {
          // Do not pick up a project's .npmrc or write package-manager output to command stdout.
          cwd: installation.prefix,
          env: environment,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        },
      )
      // npm owns replacement and recovery. Do not kill it mid-rename on a short startup deadline.
      if ((await child.exited) !== 0)
        throw new Error(
          'npm upgrade failed; retry factory upgrade or npm install -g @dzhng/factory',
        )
      const updated = await readBoundedOrdinaryFile(manifestPath, 64 * 1024)
      if (!updated || JSON.parse(new TextDecoder().decode(updated)).version !== latest)
        throw new Error('npm did not install the requested Factory version')
      log(`Factory upgraded to ${latest}. New commands will use it.\n`)
    },
    automatic ? 0 : 30_000,
  )
}
