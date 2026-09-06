import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalJson, makeOwnedPath, objectOwnedPath } from '../../contract/src/index'
import { initializeRepositoryStore, openRepositoryStore } from '../src/index'

if (process.env.FACTORY_DOCKER_TEST !== '1') {
  throw new Error('repository workbench must run in the project Docker test environment')
}

const outputRoot = process.argv[2]
if (outputRoot === undefined) throw new Error('workbench requires an output directory')
const recordId = (prefix: string) => `${prefix}_${'0'.repeat(26)}`

const manifest = {
  schemaVersion: 1 as const,
  format: 'factory-repository' as const,
  minimumReaderVersion: '0.1.0',
  repositoryId: 'repo_01JFACTORYWORKBENCH00000000' as const,
  createdAt: '2026-09-04T00:00:00Z',
}

async function tree(root: string, current = root): Promise<string[]> {
  const paths: string[] = []
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(current, entry.name)
    const relative = path.slice(root.length + 1)
    paths.push(entry.isDirectory() ? `${relative}/` : relative)
    if (entry.isDirectory()) paths.push(...(await tree(root, path)))
  }
  return paths
}

async function makeRepository(label: string, withGit = true) {
  const root = await mkdtemp(join(tmpdir(), `factory-${label}-`))
  if (withGit) await mkdir(join(root, '.git'))
  return root
}

const validRoot = await makeRepository('valid')
const valid = await initializeRepositoryStore(validRoot, manifest, {
  canonicalBranch: 'main',
  futurePolicy: { preserved: true },
})
const raw = new TextEncoder().encode('{"provider":"codex","unknown":{"future":true}}\n')
const rawRef = await valid.putObject(
  (async function* () {
    yield raw.subarray(0, 11)
    yield raw.subarray(11)
  })(),
  { mediaType: 'application/jsonl', role: 'provider-event' },
)
await valid.createImmutable(
  makeOwnedPath('sessions', ['codex', 'session_01', 'identity.json']),
  new TextEncoder().encode(
    canonicalJson({
      schemaVersion: 1,
      provider: 'codex',
      nativeSessionId: 'native-session-01',
      sessionKey: 'session_01',
      captureGeneration: 1,
      repositoryId: manifest.repositoryId,
      firstObservedAt: manifest.createdAt,
    }),
  ),
)
await valid.createImmutable(
  makeOwnedPath('sessions', ['codex', 'session_01', 'lifecycle', `${recordId('event')}.json`]),
  new TextEncoder().encode(
    canonicalJson({
      schemaVersion: 1,
      eventId: recordId('event'),
      sessionKey: 'session_01',
      providerEvent: 'SessionStart',
      observedAt: manifest.createdAt,
      evidence: rawRef,
    }),
  ),
)
const validVerification = await valid.verify()
if (validVerification.issues.length !== 0) throw new Error('valid workbench tree did not verify')

const partialRoot = await makeRepository('partial')
const partial = await initializeRepositoryStore(partialRoot, manifest, {})
await partial.createImmutable(
  makeOwnedPath('review-triggers', [`${recordId('trigger')}.json`]),
  new TextEncoder().encode(
    canonicalJson({
      schemaVersion: 1,
      triggerId: recordId('trigger'),
      sessionKey: 'session_01',
      turnId: recordId('turn'),
      evidenceWatermark: 3,
      provider: 'codex',
      createdAt: manifest.createdAt,
      materialization: 'partial',
      limitations: [{ code: 'missing-transcript-range', detail: 'fixture gap' }],
    }),
  ),
)
const partialVerification = await partial.verify()
if (partialVerification.issues.length !== 0) {
  throw new Error('partial workbench tree did not verify as an honest partial record')
}

const corruptRoot = await makeRepository('corrupt')
const corrupt = await initializeRepositoryStore(corruptRoot, manifest, {})
const corruptRef = await corrupt.putObject(
  (async function* () {
    yield new TextEncoder().encode('expected')
  })(),
)
await writeFile(join(corruptRoot, '.factory', objectOwnedPath(corruptRef.sha256)), 'substituted')
const corruptVerification = await corrupt.verify()

const tooNewRoot = await makeRepository('too-new')
await mkdir(join(tooNewRoot, '.factory'))
await writeFile(
  join(tooNewRoot, '.factory', 'manifest.json'),
  canonicalJson({ ...manifest, minimumReaderVersion: '9.0.0' }),
)
let tooNewResult = 'not-refused'
try {
  await openRepositoryStore(tooNewRoot)
} catch (error) {
  tooNewResult = error instanceof Error ? error.name : 'unknown-error'
}

const foreignRoot = await makeRepository('foreign')
const foreign = await initializeRepositoryStore(foreignRoot, manifest, { futureKey: 'keep' })
await mkdir(join(foreignRoot, '.factory', 'skills'))
const foreignBytes = new Uint8Array([0, 255, 7, 9])
await writeFile(join(foreignRoot, '.factory', 'skills', 'foreign.bin'), foreignBytes)
await foreign.updateConfig({ canonicalBranch: 'trunk' })
const foreignPreserved = Buffer.from(
  await readFile(join(foreignRoot, '.factory', 'skills', 'foreign.bin')),
).equals(foreignBytes)

const reconstructedRoot = await makeRepository('reconstructed', false)
await valid.materializeObjectInventory([rawRef], reconstructedRoot)
const reconstructedPath = join(reconstructedRoot, objectOwnedPath(rawRef.sha256))
const reconstructedHash = createHash('sha256')
  .update(await readFile(reconstructedPath))
  .digest('hex')
const reconstructedWithoutGit = !(await readdir(reconstructedRoot)).includes('.git')

const report = {
  schemaVersion: 1,
  fixtures: {
    valid: { verification: validVerification, tree: await tree(join(validRoot, '.factory')) },
    partial: {
      verification: partialVerification,
      tree: await tree(join(partialRoot, '.factory')),
    },
    corrupt: { verification: corruptVerification, tree: await tree(join(corruptRoot, '.factory')) },
    tooNew: { result: tooNewResult, tree: await tree(join(tooNewRoot, '.factory')) },
    foreign: { preserved: foreignPreserved, tree: await tree(join(foreignRoot, '.factory')) },
  },
  reconstruction: {
    selectedObjects: [rawRef],
    sha256Verified: reconstructedHash === rawRef.sha256,
    withoutGit: reconstructedWithoutGit,
  },
}

if (
  !foreignPreserved ||
  tooNewResult !== 'UnsupportedRepositoryVersionError' ||
  !report.reconstruction.sha256Verified ||
  !report.reconstruction.withoutGit ||
  !corruptVerification.issues.some(issue => issue.code === 'object-digest-mismatch')
) {
  throw new Error('repository workbench acceptance failed')
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

const fixtureLabels: Record<keyof typeof report.fixtures, { title: string; outcome: string }> = {
  valid: { title: 'valid repository', outcome: 'verified without issues' },
  partial: { title: 'minimal repository', outcome: 'verified without invented data' },
  corrupt: { title: 'corrupt repository', outcome: 'digest mismatch detected' },
  tooNew: { title: 'too-new repository', outcome: 'unsupported version refused' },
  foreign: { title: 'foreign content', outcome: 'unknown bytes preserved' },
}
const invalidFixtures = new Set<keyof typeof report.fixtures>(['corrupt', 'tooNew'])
const cards = (
  Object.entries(report.fixtures) as [keyof typeof report.fixtures, { tree: string[] }][]
)
  .map(
    ([name, fixture]) =>
      `<article><h2 class="${invalidFixtures.has(name) ? 'invalid-input' : ''}">${escapeHtml(fixtureLabels[name].title)}</h2><p class="input-kind">${invalidFixtures.has(name) ? 'invalid input fixture' : 'accepted input fixture'}</p><p class="outcome">✓ expected handling passed: ${escapeHtml(fixtureLabels[name].outcome)}</p><pre>${escapeHtml(fixture.tree.join('\n'))}</pre></article>`,
  )
  .join('\n')
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Factory repository workbench</title><style>body{font:15px/1.45 system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;background:#101416;color:#e7efed}h1{font-size:2rem}.grid{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem}article{min-width:0;background:#182023;border:1px solid #5b7377;border-radius:10px;padding:1rem}h2{margin:0;color:#d8efea}.invalid-input{color:#ffca73}.input-kind{margin:.2rem 0;color:#aebcba;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em}.outcome{margin:.25rem 0 .8rem;color:#83e377}pre{margin-bottom:0;overflow-x:auto;white-space:pre;color:#e1e8e6;font-size:.9rem;line-height:1.55}.ok{color:#a8eaa5}</style></head><body><h1>Repository format workbench</h1><p class="ok">All expected handling passed. Each card is a deliberately different fixture, including incomplete and invalid input.</p><div class="grid">${cards}</div></body></html>\n`

await mkdir(outputRoot, { recursive: true })
await writeFile(join(outputRoot, 'report.json'), canonicalJson(report))
await writeFile(join(outputRoot, 'index.html'), html)
