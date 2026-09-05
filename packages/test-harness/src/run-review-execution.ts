import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { canonicalJson, type ReviewManifest } from '@factory/contract'
import type { RepositoryStore } from '@factory/repository'
import { acceptReview, validateReview } from '@factory/review'
import {
  dockerReviewerExecutor,
  openVerifiedReviewBundle,
  readReviewerRawAttempt,
  readVerifiedReviewBundle,
  reviewerAdapter,
  reviewerAuthContainerPath,
  type ReviewerChoice,
} from '@factory/reviewer'
import { planReviewerIsolation, runIsolationProbe } from '@factory/reviewer/testing'

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
    const context = resolve(import.meta.dir, '../docker/reviewer-isolation')
    const imageDigest = await command(['docker', 'build', '--quiet', context])
    const authRoot = join(root, 'auth')
    await mkdir(authRoot)
    const auth = join(authRoot, 'auth.json')
    await writeFile(auth, 'dedicated-fake-credential\n', { mode: 0o444 })
    const raw = await dockerReviewerExecutor.run(
      bundle,
      { settings: bundleManifest.plan.policies.reviewer },
      {
        reviewId: 'review_00000000000000000000000009',
        imageDigest,
        runtimeRoot: root,
        auth: [{ hostPath: auth, containerPath: '/auth/codex/auth.json' }],
        timeoutMs: 5_000,
        containerIdentity: {
          name: `factory-review-execution-${randomUUID()}`,
          label: randomUUID(),
        },
      },
    )
    const observation = readReviewerRawAttempt(raw)
    const verified = await readVerifiedReviewBundle(bundle)
    const validated = await validateReview(bundle, raw)
    let manifest: ReviewManifest | undefined
    const store = {
      manifest: { repositoryId: verified.authority.repositoryId },
      async readImmutable() {
        return new TextEncoder().encode(canonicalJson(verified.authority.subjectRecord))
      },
      async getObject() {
        return new Uint8Array()
      },
      async publishImmutableGroup(records: readonly { path: string; bytes: Uint8Array }[]) {
        const value = records.find(record => record.path.endsWith('manifest.json'))!
        manifest = JSON.parse(new TextDecoder().decode(value.bytes)) as ReviewManifest
        return { path: value.path, sha256: '', bytes: value.bytes.byteLength }
      },
      async publishReview(
        _authority: unknown,
        records: readonly { path: string; bytes: Uint8Array }[],
      ) {
        const value = records.find(record => record.path.endsWith('manifest.json'))!
        manifest = JSON.parse(new TextDecoder().decode(value.bytes)) as ReviewManifest
        return { path: value.path, sha256: '', bytes: value.bytes.byteLength }
      },
    } as unknown as RepositoryStore
    const accepted = await acceptReview(validated, store)
    if (
      observation.termination !== 'completed' ||
      observation.exitCode !== 0 ||
      accepted.disposition !== 'complete' ||
      manifest?.bundleSha256 !== report.bundles.complete
    ) {
      throw new Error(
        `fake review execution did not satisfy the production contract: ${JSON.stringify({ observation, accepted, manifest })}`,
      )
    }

    for (const expected of [
      {
        provider: 'claude',
        behavior: 'factory-test-prefix-nonzero',
        termination: 'completed',
        exitCode: 1,
      },
      {
        provider: 'claude',
        behavior: 'factory-test-prefix-timeout',
        termination: 'timed-out',
        exitCode: null,
      },
      {
        provider: 'claude',
        behavior: 'factory-test-oversized',
        termination: 'completed',
        exitCode: 1,
      },
      {
        provider: 'codex',
        behavior: 'factory-test-oversized',
        termination: 'completed',
        exitCode: 1,
      },
    ] as const) {
      const scenarioAuth = join(authRoot, `${expected.provider}-${expected.behavior}.json`)
      const scenarioOutput = join(root, `${expected.provider}-${expected.behavior}`)
      await writeFile(scenarioAuth, expected.behavior, { mode: 0o444 })
      await mkdir(scenarioOutput)
      await chmod(scenarioOutput, 0o777)
      const scenarioPlan = planReviewerIsolation({
        provider: expected.provider,
        bundleHostPath: bundlePath,
        outputHostPath: scenarioOutput,
        auth: [
          {
            hostPath: scenarioAuth,
            containerPath: reviewerAuthContainerPath(expected.provider),
          },
        ],
      })
      if (!scenarioPlan.ok) throw new Error(scenarioPlan.detail)
      const scenario = await runIsolationProbe(scenarioPlan.plan, {
        imageDigest,
        expectedBundleSha256: report.bundles.complete,
        reviewer: {
          model: `${expected.provider}-test`,
          effort: 'high',
          promptVersion: 'prompt-v1',
        },
        invocation: reviewerAdapter({
          provider: expected.provider,
          model: `${expected.provider}-test`,
          effort: 'high',
        }),
        containerIdentity: {
          name: `factory-review-scenario-${randomUUID()}`,
          label: randomUUID(),
        },
        scenario: 'review',
        timeoutMs: 5_000,
        ...(expected.behavior === 'factory-test-prefix-timeout' ? { providerTimeoutMs: 250 } : {}),
      })
      const responseInfo = await stat(join(scenarioOutput, 'response.txt'))
      if (
        scenario.termination !== expected.termination ||
        scenario.exitCode !== expected.exitCode ||
        responseInfo.size === 0 ||
        (expected.behavior === 'factory-test-oversized' && responseInfo.size > 1024 * 1024)
      )
        throw new Error(`review response boundary failed: ${expected.behavior}`)
    }
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, imageDigest, termination: observation.termination, disposition: accepted.disposition, bundleSha256: manifest.bundleSha256 })}\n`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
