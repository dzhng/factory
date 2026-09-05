import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { canonicalJson } from '@factory/contract'
import {
  dockerReviewerExecutor,
  openVerifiedReviewBundle,
  readReviewerRawAttempt,
  resolveReviewerAuthentication,
  ReviewAttemptCoordinator,
  type ReviewerChoice,
} from '@factory/reviewer'

import { certifyLiveCapture, type LiveCaptureObservation } from './live-capture-contract'

const provider = process.argv[2]
if (provider !== 'codex' && provider !== 'claude') throw new Error('Supply codex or claude')
const imageReference = process.argv[3]
if (imageReference === undefined || !/^sha256:[a-f0-9]{64}$/.test(imageReference))
  throw new Error('Supply the exact test-only live-capture image ID')
const root = await mkdtemp(join(tmpdir(), 'factory-live-capture-'))
console.log(JSON.stringify({ runtime: root }))
const bundlePath = join(root, 'bundle')
const choice: ReviewerChoice = {
  settings: {
    provider,
    model: provider === 'codex' ? 'gpt-5.6-sol' : 'claude-opus-5',
    effort: 'low',
  },
}
await mkdir(bundlePath)
const fixturePath = resolve(
  import.meta.dir,
  '../../../specs/done/factory-v1/assets/review-plan/complete-bundle',
)
const manifest = JSON.parse(await readFile(join(fixturePath, 'bundle.json'), 'utf8'))
manifest.plan.policies.reviewer = choice.settings
const bytes = canonicalJson(manifest)
const prepare = Bun.spawn(
  [
    'docker',
    'run',
    '--interactive',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    `${process.getuid?.()}:${process.getgid?.()}`,
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount',
    `type=bind,src=${fixturePath},dst=/fixture,readonly`,
    '--mount',
    `type=bind,src=${bundlePath},dst=/prepared`,
    '--entrypoint',
    'bun',
    imageReference,
    '/opt/factory/prepare-bundle.ts',
  ],
  { stdin: new Blob([bytes]), stdout: 'ignore', stderr: 'inherit' },
)
const preparationDeadline = setTimeout(() => prepare.kill('SIGKILL'), 30_000)
const preparedCode = await prepare.exited
clearTimeout(preparationDeadline)
if (preparedCode !== 0) throw new Error('Docker could not prepare the portable fixture bundle')
const bundle = await openVerifiedReviewBundle(
  bundlePath,
  createHash('sha256').update(bytes).digest('hex'),
)
const runtime = join(root, 'runtime')
await mkdir(runtime, { mode: 0o700 })
const coordinator = await ReviewAttemptCoordinator.open({ testRuntimeRoot: runtime })
const home = process.env.HOME ?? homedir()
const codexHome = process.env.CODEX_HOME ?? join(home, '.codex')
const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
const sentinelPaths = [
  join(codexHome, 'config.toml'),
  join(codexHome, 'hooks.json'),
  join(claudeHome, 'settings.json'),
]
async function configurationSentinels() {
  return await Promise.all(
    sentinelPaths.map(async path => {
      const info = await stat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (info === undefined) return null
      if (info.size > 1024 * 1024) throw new Error('host configuration sentinel exceeds bound')
      return createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    }),
  )
}
const beforeConfiguration = await configurationSentinels()
const auth = await resolveReviewerAuthentication(process.env)
if (!auth.availability[provider]) throw new Error(`${provider} existing CLI login unavailable`)
const attempt = await coordinator.run(bundle, choice, dockerReviewerExecutor, {
  imageReference,
  imageDigest: imageReference,
  credential: auth.sources[provider],
  timeoutMs: 300_000,
})
const result = readReviewerRawAttempt(attempt)
assert.deepEqual(
  await configurationSentinels(),
  beforeConfiguration,
  'host provider configuration changed',
)
for (const entry of await readdir(join(runtime, 'review-attempts-v1'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  assert.ok(
    !(await readdir(join(runtime, 'review-attempts-v1', entry.name))).some(name =>
      name.startsWith('review-auth-'),
    ),
    'attempt credential staging was not cleaned',
  )
}
const { response, ...metadata } = result
await writeFile(join(root, 'attempt.json'), canonicalJson(metadata), { mode: 0o600 })
await writeFile(join(root, 'response.json'), result.response, { mode: 0o600 })
console.log(
  JSON.stringify({
    root,
    termination: result.termination,
    exitCode: result.exitCode,
    providerCliVersion: result.providerCliVersion,
    responseBytes: result.response.length,
  }),
)
if (result.termination !== 'completed' || result.exitCode !== 0)
  throw new Error('live capture container did not complete')
const observation = JSON.parse(new TextDecoder().decode(response)) as LiveCaptureObservation
const certification = certifyLiveCapture(observation)
await writeFile(
  join(root, 'report.json'),
  canonicalJson({
    authority: 'authenticated-live-capture',
    imageDigest: imageReference,
    providerCliVersion: result.providerCliVersion,
    hostConfigurationUnchanged: true,
    attemptCredentialStagingCleaned: true,
    ...certification,
  }),
  { mode: 0o600 },
)
