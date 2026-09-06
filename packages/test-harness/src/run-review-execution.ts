import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { canonicalJson, readAuditDraft, type ReviewManifest } from '@factory/contract'
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
import { createSanitizer } from '@factory/sanitization'

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
    const assets = resolve(import.meta.dir, '../../../specs/done/factory-v1/assets/review-plan')
    const report = JSON.parse(await readFile(join(assets, 'report.json'), 'utf8')) as {
      bundles: { complete: string }
    }
    const bundlePath = join(assets, 'complete-bundle')
    const bundle = await openVerifiedReviewBundle(bundlePath, report.bundles.complete)
    const bundleManifest = JSON.parse(await readFile(join(bundlePath, 'bundle.json'), 'utf8')) as {
      plan: { policies: { reviewer: ReviewerChoice['settings'] } }
    }
    const dockerfile = resolve(import.meta.dir, '../docker/reviewer-isolation/Dockerfile')
    const imageDigest = await command([
      'docker',
      'build',
      '--quiet',
      '--file',
      dockerfile,
      resolve(import.meta.dir, '../../..'),
    ])
    const authRoot = join(root, 'auth')
    await mkdir(authRoot)
    const auth = join(authRoot, 'auth.json')
    await writeFile(auth, 'factory-test-verdicts\n', { mode: 0o444 })
    const raw = await dockerReviewerExecutor.run(
      bundle,
      { settings: bundleManifest.plan.policies.reviewer },
      {
        reviewId: 'review_00000000000000000000000009',
        imageReference: imageDigest,
        imageDigest,
        runtimeRoot: root,
        credential: {
          kind: 'file',
          mount: { hostPath: auth, containerPath: '/auth/codex/auth.json' },
        },
        timeoutMs: 5_000,
        containerIdentity: {
          name: `factory-review-execution-${randomUUID()}`,
          label: randomUUID(),
        },
      },
    )
    const observation = readReviewerRawAttempt(raw)
    const verified = await readVerifiedReviewBundle(bundle)
    const validated = await validateReview(bundle, raw, { sanitizer: createSanitizer([]) })
    const submitted = readAuditDraft(
      observation.submissions,
      verified.manifest.inventory,
      observation.reviewId,
    )
    if (submitted.entries.length !== 3 || submitted.incomplete)
      throw new Error('provider did not submit three verdicts through the configured tools')
    let manifest: ReviewManifest | undefined
    const store = {
      manifest: { repositoryId: verified.authority.repositoryId },
      async readImmutable() {
        return new TextEncoder().encode(canonicalJson(verified.authority.subjectRecord))
      },
      async getObject() {
        return new Uint8Array()
      },
      async createImmutable(path: string, bytes: Uint8Array) {
        return { path, sha256: '', bytes: bytes.byteLength }
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

    const toolJourneys: unknown[] = []
    for (const expected of [
      ...(['codex', 'claude'] as const).flatMap(provider => [
        {
          provider,
          behavior: 'factory-test-verdicts',
          termination: 'completed',
          exitCode: 0,
          choices: 3,
          complete: true,
        },
        {
          provider,
          behavior: 'factory-test-zero',
          termination: 'completed',
          exitCode: 0,
          choices: 0,
          complete: true,
        },
        {
          provider,
          behavior: 'factory-test-verdicts factory-test-prefix-timeout',
          termination: 'timed-out',
          exitCode: null,
          choices: 3,
          complete: false,
        },
        {
          provider,
          behavior: 'factory-test-verdicts factory-test-malformed',
          termination: 'completed',
          exitCode: 0,
          choices: 0,
          complete: false,
        },
      ]),
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
        imageReference: imageDigest,
        imageDigest,
        expectedBundleSha256: report.bundles.complete,
        reviewer: {
          model: `${expected.provider}-test`,
          effort: 'high',
          promptVersion: 'prompt-v1',
        },
        invocation: reviewerAdapter(
          {
            provider: expected.provider,
            model: `${expected.provider}-test`,
            effort: 'high',
          },
          report.bundles.complete,
        ),
        containerIdentity: {
          name: `factory-review-scenario-${randomUUID()}`,
          label: randomUUID(),
        },
        scenario: 'review',
        timeoutMs: 5_000,
        ...(expected.behavior.includes('factory-test-prefix-timeout')
          ? { providerTimeoutMs: 500 }
          : {}),
      })
      if ('choices' in expected) {
        const draft = readAuditDraft(
          await readFile(join(scenarioOutput, 'submissions.jsonl')),
          verified.manifest.inventory,
          'review_00000000000000000000000011',
        )
        if (draft.entries.length !== expected.choices || draft.incomplete === expected.complete)
          throw new Error('provider submission completion or retained prefix differed')
        if (
          draft.entries.some(entry => !entry.scenario.includes('\n') || entry.evidence.length !== 1)
        )
          throw new Error('structured prose or citations changed across provider tools')
        toolJourneys.push({
          provider: expected.provider,
          behavior: expected.behavior,
          complete: !draft.incomplete,
          entries: draft.entries,
        })
      }
      const responseInfo = await stat(join(scenarioOutput, 'response.txt'))
      if (
        scenario.termination !== expected.termination ||
        scenario.exitCode !== expected.exitCode ||
        responseInfo.size === 0 ||
        responseInfo.size > scenario.containerPolicy.fileSizeBytes ||
        // Stream output retains one extra byte so the host can prove truncation.
        (expected.behavior === 'factory-test-oversized' &&
          expected.provider === 'claude' &&
          responseInfo.size !== 1024 * 1024 + 1)
      )
        throw new Error(
          `review response boundary failed: ${JSON.stringify({ expected, termination: scenario.termination, exitCode: scenario.exitCode, responseBytes: responseInfo.size })}`,
        )
      if (expected.behavior === 'factory-test-oversized' && expected.provider === 'codex') {
        const truncated = readReviewerRawAttempt(
          await dockerReviewerExecutor.run(
            bundle,
            { settings: bundleManifest.plan.policies.reviewer },
            {
              reviewId: 'review_00000000000000000000000010',
              imageReference: imageDigest,
              imageDigest,
              runtimeRoot: root,
              credential: {
                kind: 'file',
                mount: { hostPath: scenarioAuth, containerPath: '/auth/codex/auth.json' },
              },
              timeoutMs: 5_000,
              containerIdentity: {
                name: `factory-review-overflow-${randomUUID()}`,
                label: randomUUID(),
              },
            },
          ),
        )
        if (
          truncated.termination !== 'crashed' ||
          truncated.exitCode !== 1 ||
          !truncated.outputTruncated ||
          truncated.submissions.byteLength !== 1024 * 1024
        )
          throw new Error('production executor did not retain a bounded, explicitly partial prefix')
      }
    }
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, authority: 'deterministic provider executables using packaged MCP server; publication store is synthetic', imageDigest, termination: observation.termination, disposition: accepted.disposition, bundleSha256: manifest.bundleSha256, toolJourneys })}\n`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
