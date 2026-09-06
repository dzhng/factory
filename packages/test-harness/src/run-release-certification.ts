import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  RELEASE_ARCHIVE_MAXIMUM_BYTES,
  RELEASE_METADATA_MAXIMUM_BYTES,
  verifyReleaseArtifact,
  type ReleaseTarget,
} from '@factory/cli'
import { type ReviewLedger, type ReviewManifest, type ReviewTrigger } from '@factory/contract'
import { type StoredReviewResult } from '@factory/review'
import {
  DEFAULT_REVIEWER_IMAGE_REFERENCE,
  resolveReviewerAuthentication,
  reviewerImageIdentity,
} from '@factory/reviewer'

import { succeed, replayProvider, openAndConfirmDecision } from './release-fixtures'
type Journey = { name: string; status: 'passed'; detail: string }

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function required(name: string): string {
  const value = option(name)
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return resolve(value)
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function html(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

async function readBoundedOrdinaryFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`${path} is not an ordinary file`)
    if (info.size === 0 || info.size > maximumBytes)
      throw new Error(`${path} exceeds its certification size bound`)
    const bytes = new Uint8Array(info.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) throw new Error(`${path} changed while certification read it`)
      offset += bytesRead
    }
    if ((await handle.read(new Uint8Array(1), 0, 1, offset)).bytesRead !== 0)
      throw new Error(`${path} changed while certification read it`)
    return bytes
  } finally {
    await handle.close()
  }
}

const archivePath = required('--archive')
const manifestPath = required('--manifest')
const expectedVersion = option('--expected-version')
if (expectedVersion === undefined) throw new Error('--expected-version is required')
const expectedManifestSha256 = option('--manifest-sha256')
if (expectedManifestSha256 === undefined) throw new Error('--manifest-sha256 is required')
const reportRoot = resolve(option('--output') ?? join(tmpdir(), 'factory-release-certification'))
const hostKeychainFile =
  process.platform === 'darwin' && process.env.HOME !== undefined
    ? join(process.env.HOME, 'Library', 'Keychains', 'login.keychain-db')
    : undefined
const hostAuthentication = await resolveReviewerAuthentication({
  ...process.env,
  ...(hostKeychainFile === undefined ? {} : { FACTORY_CLAUDE_KEYCHAIN_FILE: hostKeychainFile }),
})
const codexCredential = hostAuthentication.sources.codex
const claudeCredential = hostAuthentication.sources.claude
const reviewerImage = option('--reviewer-image') ?? DEFAULT_REVIEWER_IMAGE_REFERENCE
const productionReviewer =
  codexCredential === undefined || claudeCredential === undefined
    ? undefined
    : {
        image: reviewerImage,
        imageDigest: reviewerImageIdentity(reviewerImage).digest,
        codexCredential,
        claudeCredential,
      }
const archive = await readBoundedOrdinaryFile(archivePath, RELEASE_ARCHIVE_MAXIMUM_BYTES)
const adjacentManifest = await readBoundedOrdinaryFile(manifestPath, RELEASE_METADATA_MAXIMUM_BYTES)
const adjacent = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(adjacentManifest)) as {
  release: { target: ReleaseTarget }
}
const release = await verifyReleaseArtifact({
  archive,
  adjacentManifest,
  expectedManifestSha256,
  expectedTarget: adjacent.release.target,
})
if (release.version !== expectedVersion)
  throw new Error('certified release version does not match the requested version')
// macOS exposes its temporary directory through /var while realpath resolves provider homes
// through /private/var. Canonicalize once so hook payload paths share the confinement root.
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'factory-release-')))
const journeys: Journey[] = []

try {
  const home = join(scratch, 'home')
  const repository = join(scratch, 'repository')
  const bin = join(scratch, 'bin')
  const executable = join(bin, 'factory')
  await Promise.all([
    mkdir(join(home, '.codex'), { recursive: true }),
    mkdir(join(home, '.claude'), { recursive: true }),
    mkdir(repository),
    mkdir(bin),
  ])
  await writeFile(executable, release.executable, { mode: 0o755 })
  await chmod(executable, 0o755)
  for (const launcher of ['open', 'xdg-open']) {
    const path = join(bin, launcher)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
  }
  const docker = (
    await succeed('sh', ['-c', 'command -v docker'], scratch, process.env)
  ).stdout.trim()
  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.state'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PATH: `${bin}:${dirname(docker)}:/usr/bin:/bin`,
  }
  await succeed('git', ['init', '-b', 'main'], repository, environment)
  await succeed('git', ['config', 'user.email', 'factory@example.invalid'], repository, environment)
  await succeed('git', ['config', 'user.name', 'Factory Certification'], repository, environment)
  await writeFile(join(repository, 'app.ts'), 'export const certified = true\n')
  await succeed('git', ['add', 'app.ts'], repository, environment)
  await succeed('git', ['commit', '-m', 'certification fixture'], repository, environment)
  await succeed(executable, ['--version'], repository, environment)
  await succeed(executable, ['init', '--canonical-branch', 'main'], repository, environment)
  await succeed('git', ['add', '.factory'], repository, environment)
  await succeed('git', ['commit', '-m', 'initialize Factory'], repository, environment)
  const factoryHead = (await succeed('git', ['rev-parse', 'HEAD'], repository, environment)).stdout
  await succeed(executable, ['install'], repository, environment)
  journeys.push({ name: 'install', status: 'passed', detail: 'both provider hooks reconciled' })

  await replayProvider('codex', executable, repository, home, environment)
  await replayProvider('claude', executable, repository, home, environment)
  journeys.push({
    name: 'capture',
    status: 'passed',
    detail: 'both native provider fixtures stored',
  })

  const auth = join(scratch, 'review-auth.json')
  // Match the consumer UID so private submission files remain readable after Docker exits.
  await writeFile(auth, 'factory-test-decision\n', { mode: 0o600 })
  await chmod(auth, 0o600)
  const image = (
    await succeed(
      'docker',
      [
        'build',
        '-q',
        '--file',
        resolve(import.meta.dir, '../docker/reviewer-isolation/Dockerfile'),
        resolve(import.meta.dir, '../../..'),
      ],
      scratch,
      process.env,
    )
  ).stdout.trim()
  const reviewEnvironment = {
    ...environment,
    FACTORY_CODEX_AUTH_FILE: auth,
    FACTORY_CLAUDE_AUTH_FILE: join(scratch, 'not-authenticated.json'),
    FACTORY_REVIEWER_IMAGE: image,
    FACTORY_CODEX_REVIEW_MODEL: 'gpt-test',
    FACTORY_CODEX_REVIEW_EFFORT: 'high',
  }
  const review = await succeed(executable, ['review'], repository, reviewEnvironment)
  const reviewResult = JSON.parse(review.stdout) as StoredReviewResult
  if (reviewResult.disposition !== 'complete')
    throw new Error(`review was not complete: ${review.stdout.trim()}`)
  journeys.push({
    name: 'review',
    status: 'passed',
    detail: 'isolated deterministic review accepted',
  })

  await openAndConfirmDecision(executable, repository, reviewEnvironment)
  journeys.push({
    name: 'ui-action',
    status: 'passed',
    detail: 'loopback projection confirmed a decision',
  })

  const readManifest = async (result: StoredReviewResult): Promise<ReviewManifest> =>
    JSON.parse(await readFile(join(repository, '.factory', result.paths.manifest), 'utf8'))
  const firstManifest = await readManifest(reviewResult)
  assert.ok(reviewResult.paths.ledger)
  const firstLedgerBytes = await readFile(join(repository, '.factory', reviewResult.paths.ledger))
  const triggerDirectory = join(repository, '.factory', 'review-triggers')
  const originalTriggerFiles = await readdir(triggerDirectory)
  await replayProvider('codex', executable, repository, home, environment, { continuing: true })
  const addedTriggerFiles = (await readdir(triggerDirectory)).filter(
    name => !originalTriggerFiles.includes(name),
  )
  assert.equal(addedTriggerFiles.length, 1, 'continuing Session must publish one new Stop trigger')
  const newTrigger = JSON.parse(
    await readFile(join(triggerDirectory, addedTriggerFiles[0]!), 'utf8'),
  ) as ReviewTrigger
  assert.equal(newTrigger.provider, 'codex')
  assert.ok(
    newTrigger.evidenceWatermark > firstManifest.sessionWatermarks[newTrigger.sessionKey]!,
    'new Stop must advance the existing Session watermark',
  )
  const incremental = JSON.parse(
    (await succeed(executable, ['review'], repository, reviewEnvironment)).stdout,
  ) as StoredReviewResult
  assert.equal(incremental.disposition, 'complete')
  const incrementalManifest = await readManifest(incremental)
  assert.notEqual(incremental.reviewId, reviewResult.reviewId)
  assert.deepEqual(
    incrementalManifest.triggerIds,
    [newTrigger.triggerId],
    'incremental attempt must cover only the new Stop',
  )
  assert.deepEqual(incrementalManifest.sessionWatermarks, {
    [newTrigger.sessionKey]: newTrigger.evidenceWatermark,
  })
  assert.equal(
    incrementalManifest.coverageTargetWatermarks[newTrigger.sessionKey],
    newTrigger.evidenceWatermark,
  )
  assert.equal(
    incrementalManifest.priorLedger?.sha256,
    digest(firstLedgerBytes),
    'incremental input must pin the accepted prior ledger',
  )
  const newSelection = incrementalManifest.evidenceSelections.find(
    selection => selection.triggerId === newTrigger.triggerId,
  )
  assert.equal(newSelection?.coverageEffect, 'eligible-included')
  assert.equal(newSelection?.selectedForReview, true)
  for (const triggerId of firstManifest.triggerIds) {
    const selection = incrementalManifest.evidenceSelections.find(
      item => item.triggerId === triggerId,
    )
    assert.equal(
      selection?.coverageEffect,
      'settled',
      'previous Stops must retain exact settled coverage',
    )
    assert.equal(selection?.selectedForReview, false)
  }
  assert.ok(incremental.paths.ledger)
  const incrementalLedger = JSON.parse(
    await readFile(join(repository, '.factory', incremental.paths.ledger), 'utf8'),
  ) as ReviewLedger
  assert.ok(
    incrementalLedger.entries.some(entry =>
      entry.evidence.some(
        citation => citation.object?.sha256 === incrementalManifest.priorLedger?.sha256,
      ),
    ),
    'fixture reviewer must demonstrate access to the pinned prior ledger',
  )
  journeys.push({
    name: 'incremental-coverage',
    status: 'passed',
    detail: 'continuing Session advances exact Stop coverage with the accepted prior ledger',
  })

  const noDockerBin = join(scratch, 'no-docker')
  await mkdir(noDockerBin)
  const dockerTrap = join(noDockerBin, 'docker')
  await writeFile(dockerTrap, '#!/bin/sh\nprintf invoked > "$0.invoked"\nexit 77\n', {
    mode: 0o755,
  })
  const reviewsBeforeNoOp = (
    await readdir(join(repository, '.factory', 'reviews', 'workspace'))
  ).sort()
  const repeated = JSON.parse(
    (
      await succeed(executable, ['review'], repository, {
        ...reviewEnvironment,
        PATH: `${noDockerBin}:${reviewEnvironment.PATH}`,
      })
    ).stdout,
  ) as StoredReviewResult
  assert.equal(repeated.status, 'already-reviewed')
  assert.equal(repeated.reviewId, incremental.reviewId)
  assert.deepEqual(await readManifest(repeated), incrementalManifest)
  assert.deepEqual(
    (await readdir(join(repository, '.factory', 'reviews', 'workspace'))).sort(),
    reviewsBeforeNoOp,
  )
  await assert.rejects(
    readFile(`${dockerTrap}.invoked`),
    { code: 'ENOENT' },
    'unchanged review must not invoke Docker',
  )
  journeys.push({
    name: 'unchanged-review',
    status: 'passed',
    detail: 'exact prior review reused without Docker or another immutable attempt',
  })

  let operationalEnvironment: NodeJS.ProcessEnv = reviewEnvironment
  if (productionReviewer !== undefined) {
    const authenticatedEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      FACTORY_REVIEWER_IMAGE: productionReviewer.image,
    }
    if (productionReviewer.codexCredential.kind !== 'file')
      throw new Error('Codex certification credential must be file-backed')
    authenticatedEnvironment.FACTORY_CODEX_AUTH_FILE =
      productionReviewer.codexCredential.mount.hostPath
    if (productionReviewer.claudeCredential.kind === 'file')
      authenticatedEnvironment.FACTORY_CLAUDE_AUTH_FILE =
        productionReviewer.claudeCredential.mount.hostPath
    else if (productionReviewer.claudeCredential.keychainFile !== undefined)
      authenticatedEnvironment.FACTORY_CLAUDE_KEYCHAIN_FILE =
        productionReviewer.claudeCredential.keychainFile
    else throw new Error('Claude certification Keychain path is unavailable')
    for (const provider of ['codex', 'claude'] as const) {
      await succeed(
        executable,
        ['configure', '--repo', '--reviewer', provider],
        repository,
        authenticatedEnvironment,
      )
      const authenticatedReview = await succeed(
        executable,
        ['review', '--force'],
        repository,
        authenticatedEnvironment,
      )
      const result = JSON.parse(authenticatedReview.stdout) as { disposition: string }
      if (result.disposition !== 'complete')
        throw new Error(`${provider} authenticated review was not complete`)
      journeys.push({
        name: `review-${provider}`,
        status: 'passed',
        detail: 'existing CLI login executed through the production image',
      })
    }
    operationalEnvironment = authenticatedEnvironment
  }

  const doctor = JSON.parse(
    (await succeed(executable, ['doctor'], repository, operationalEnvironment)).stdout,
  ) as {
    repository: string
    installation: { transaction: string }
    projection: { sessions: unknown[] }
    providers: Record<
      'codex' | 'claude',
      | { availability: 'available'; version: string }
      | { availability: 'unavailable'; reason: string }
    >
  }
  if (
    doctor.repository !== 'ok' ||
    doctor.installation.transaction !== 'absent' ||
    doctor.projection.sessions.length !== 2
  )
    throw new Error('doctor did not verify the certified installation')
  journeys.push({
    name: 'diagnostics',
    status: 'passed',
    detail: 'repository and installation healthy',
  })

  await succeed(
    executable,
    [
      'upgrade',
      '--archive',
      archivePath,
      '--manifest',
      manifestPath,
      '--manifest-sha256',
      expectedManifestSha256,
    ],
    repository,
    operationalEnvironment,
  )
  journeys.push({
    name: 'upgrade',
    status: 'passed',
    detail: 'exact artifact atomically reinstalled',
  })

  await succeed(executable, ['uninstall'], repository, operationalEnvironment)
  const providerBytes = await Promise.all([
    readFile(join(home, '.codex', 'hooks.json'), 'utf8'),
    readFile(join(home, '.claude', 'settings.json'), 'utf8'),
  ])
  if (providerBytes.some(bytes => bytes.includes(executable)))
    throw new Error('uninstall retained an owned Factory hook')
  journeys.push({ name: 'uninstall', status: 'passed', detail: 'owned hooks removed exactly' })

  const finalHead = (await succeed('git', ['rev-parse', 'HEAD'], repository, environment)).stdout
  if (finalHead !== factoryHead) throw new Error('Factory changed the repository Git head')
  const report = {
    schemaVersion: 1,
    artifact: {
      version: release.version,
      revision: release.revision,
      target: release.target,
      manifestSha256: release.manifestSha256,
      archiveSha256: digest(archive),
      executableSha256: release.executableSha256,
    },
    platform: {
      os: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      bun: Bun.version,
      git: (await succeed('git', ['--version'], scratch, environment)).stdout.trim(),
      docker: (await succeed('docker', ['--version'], scratch, environment)).stdout.trim(),
    },
    providers: doctor.providers,
    authorities: {
      providerExecution:
        productionReviewer === undefined
          ? 'deterministic-isolation-fixture'
          : 'authenticated-production-image',
      realProviderCredentials:
        productionReviewer === undefined ? 'unavailable' : 'authenticated-local-clis',
      reviewerImageDigest: productionReviewer?.imageDigest ?? 'local-fixture',
      githubReleaseAttestation: 'unavailable',
    },
    journeys,
  }
  const authorityRows = Object.entries(report.authorities)
    .map(
      ([name, value]) =>
        `<tr><td><code>${html(name)}</code></td><td class="authority-evidence ${value === 'unavailable' ? 'unavailable' : 'passed'}">${value === 'unavailable' ? '— unavailable' : `<span aria-hidden="true">✓</span><span class="${name === 'reviewerImageDigest' ? 'digest' : ''}">${html(value)}</span>`}</td></tr>`,
    )
    .join('')
  const authoritySummary =
    productionReviewer === undefined
      ? {
          passed: 'The deterministic release journey passed.',
          blocked:
            'Blocked: authenticated provider and GitHub release authority remain unavailable.',
        }
      : {
          passed: 'Both authenticated provider journeys passed.',
          blocked: 'Blocked: GitHub release authority remains unavailable.',
        }
  await mkdir(reportRoot, { recursive: true })
  await writeFile(join(reportRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(
    join(reportRoot, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Factory release evidence</title><style>body{font:16px/1.5 system-ui;max-width:900px;margin:3rem auto;padding:0 1rem;color:#171a1c}h1{margin-bottom:.25rem}.verdict{display:inline-block;margin:.35rem 0 .8rem;padding:.25rem .55rem;background:#8a4300;color:white;border-radius:4px;font-weight:800;letter-spacing:.04em}.summary{border-left:4px solid #b76800;background:#fff6e8;padding:.8rem 1rem;margin-top:0}.blocker{display:block;color:#8a4300}.passed-summary{display:block;margin-top:.2rem}.candidate{line-height:1.7}.candidate code{overflow-wrap:anywhere}h2{margin-top:2rem}code{color:#36434a}table{border-collapse:collapse;width:100%;table-layout:auto}th{background:#e9eef0}th,td{border:1px solid #aab6bb;padding:.6rem;text-align:left;vertical-align:top}.authority th:first-child,.authority td:first-child{width:14rem;white-space:nowrap}.authority-evidence.passed{display:table-cell}.authority-evidence.passed>span:first-child{margin-right:.35rem}.authority-evidence span:last-child{overflow-wrap:anywhere}.authority-evidence .digest{font:0.82em ui-monospace,SFMono-Regular,Menlo,monospace;white-space:normal}.passed{color:#176b35}.unavailable{color:#8a4300;font-weight:600}@media(max-width:650px){body{margin:1.5rem auto;font-size:15px}table.authority{table-layout:fixed}.authority th:first-child,.authority td:first-child{width:50%;white-space:normal;overflow-wrap:anywhere}}</style></head><body><h1>Factory release evidence</h1><p class="verdict">NOT RELEASE-CERTIFIED</p><p class="summary"><strong class="blocker">${html(authoritySummary.blocked)}</strong><strong class="passed-summary">${html(authoritySummary.passed)}</strong></p><p class="candidate">Candidate <code>factory-${html(release.version)}-${html(release.target)}</code><br>Revision <code>${html(release.revision)}</code><br>Executable SHA-256 <code>${html(release.executableSha256)}</code></p><h2>Authority</h2><table class="authority"><thead><tr><th>Capability</th><th>Evidence</th></tr></thead><tbody>${authorityRows}</tbody></table><h2>Passed journeys</h2><table><thead><tr><th>Journey</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${journeys.map(item => `<tr><td>${html(item.name)}</td><td class="passed">✓ ${item.status}</td><td>${html(item.detail)}</td></tr>`).join('')}</tbody></table></body></html>`,
  )
  process.stdout.write(`${join(reportRoot, 'report.json')}\n${join(reportRoot, 'index.html')}\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
