import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { ReviewManifest } from '@factory/contract'
import type { RepositoryStore } from '@factory/repository'
import { acceptReview, validateReview } from '@factory/review'
import {
  dockerReviewerExecutor,
  openVerifiedReviewBundle,
  type ReviewerChoice,
} from '@factory/reviewer'

async function command(args: readonly string[]): Promise<string> {
  const child = Bun.spawn([...args], { stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${args[0]} failed: ${stderr.trim()}`)
  return stdout.trim()
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'factory-review-execution-'))
  try {
    const assets = resolve(import.meta.dir, '../../../specs/factory-v1/assets/review-plan')
    const report = JSON.parse(await readFile(join(assets, 'report.json'), 'utf8')) as {
      bundles: { complete: string }
    }
    const bundlePath = join(assets, 'complete-bundle')
    const bundle = await openVerifiedReviewBundle(bundlePath, report.bundles.complete)
    const bundleManifest = JSON.parse(await readFile(join(bundlePath, 'bundle.json'), 'utf8')) as {
      plan: { policies: { reviewer: ReviewerChoice['settings'] } }
    }
    const image = 'factory-reviewer-execution:local'
    const context = resolve(import.meta.dir, '../docker/reviewer-isolation')
    await command(['docker', 'build', '--quiet', '--tag', image, context])
    const imageDigest = await command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image])
    const output = join(root, 'output')
    const authRoot = join(root, 'auth')
    await mkdir(output)
    await chmod(output, 0o777)
    await mkdir(authRoot)
    const auth = join(authRoot, 'credentials.json')
    await writeFile(auth, 'dedicated-fake-credential\n', { mode: 0o444 })
    const raw = await dockerReviewerExecutor.run(
      bundle,
      { settings: bundleManifest.plan.policies.reviewer },
      {
        reviewId: 'review_00000000000000000000000009',
        imageDigest,
        outputHostPath: output,
        auth: [{ hostPath: auth, containerPath: '/auth/codex/credentials.json' }],
        providerCliVersion: 'fake-provider/1',
        timeoutMs: 5_000,
      },
    )
    const validated = await validateReview(bundle, raw)
    let manifest: ReviewManifest | undefined
    const store = {
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        const value = records.find(record => record.path.endsWith('manifest.json'))!
        manifest = JSON.parse(new TextDecoder().decode(value.bytes)) as ReviewManifest
        return { path: value.path, sha256: '', bytes: value.bytes.byteLength }
      },
    } as unknown as RepositoryStore
    const accepted = await acceptReview(validated, store)
    if (
      raw.termination !== 'completed' ||
      raw.exitCode !== 0 ||
      accepted.disposition !== 'complete' ||
      manifest?.bundleSha256 !== report.bundles.complete
    ) {
      throw new Error('fake review execution did not satisfy the production contract')
    }
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, imageDigest, termination: raw.termination, disposition: accepted.disposition, bundleSha256: manifest.bundleSha256 })}\n`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
