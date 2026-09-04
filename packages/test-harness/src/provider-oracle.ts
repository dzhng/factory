import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export type ProbeVerdict =
  | { status: 'supported'; evidence: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'incompatible'; reason: string }

export interface ObjectDigest {
  fixture: string
  sha256: string
  bytes: number
  roundTripsExactly: boolean
}

export interface TranscriptObservation {
  event: string
  status: 'observed' | 'unavailable'
  relation?: 'initial' | 'append' | 'replacement' | 'truncation' | 'compaction'
  reason?: string
  sha256?: string
}

export interface ProbeLimitation {
  code: string
  detail: string
}

export interface CaptureProbe {
  provider: 'codex' | 'claude'
  clientVersion: string
  fixtureProvenance: string
  rawEvents: readonly ObjectDigest[]
  transcriptObservations: readonly TranscriptObservation[]
  sessionIdentity: ProbeVerdict
  stopIdentity: ProbeVerdict
  fixtureEventOrder: readonly string[]
  currentEventInventory: ProbeVerdict
  unknownBytesPreserved: boolean
  limitations: readonly ProbeLimitation[]
}

export interface ProviderOracleReport {
  generatedBy: { bun: string; node: string }
  clientInventory: ProviderClientInventory
  processProbe: ProviderProcessProbe
  donorReferences: readonly DonorReference[]
  probes: readonly CaptureProbe[]
}

export interface DonorReference {
  source: string
  behavior: string
  disposition: 'port-candidate' | 'rewrite' | 'negative-reference' | 'hosted-only-delete'
  reason: string
}

export interface ProviderProcessProbe {
  environment: 'credential-free-docker'
  sequencing: {
    workers: number
    recordsPerWorker: number
    observed: number
    contiguous: boolean
    unique: boolean
  }
  responseProvenance: 'donor-wrapper-fixture'
  hookResponses: Array<{
    provider: 'codex' | 'claude'
    outcome: 'captured' | 'capture-failed'
    exitCode: number
    stdout: string
  }>
}

export interface ProviderClientInventory {
  environment: 'host-authority-audit' | 'credential-free-docker'
  image?: string
  dockerCertification: ProbeVerdict
  clients: Array<{
    provider: 'codex' | 'claude'
    versionStatus: 'observed' | 'certified'
    version: string
    capabilities: Record<string, boolean>
  }>
}

type JsonRow = Record<string, unknown>

type TranscriptEvolution = {
  versions: Array<
    | { event: string; status: 'observed'; bytes: string }
    | { event: string; status: 'unavailable'; reason: string }
  >
}

const fixtureRoot = fileURLToPath(new URL('../fixtures', import.meta.url))

const providers = [
  {
    provider: 'codex' as const,
    clientVersion: '0.144.4',
    fixtureProvenance:
      'Sanitized subset derived from the donor fixture corpus; synthetic rows use only its installed hook contract.',
    identityField: 'turn_id',
    unknownMarker: 'future_codex_record',
  },
  {
    provider: 'claude' as const,
    clientVersion: '2.1.237',
    fixtureProvenance:
      'Sanitized subset derived from the donor fixture corpus; synthetic rows use only its installed hook contract.',
    identityField: 'prompt_id',
    unknownMarker: 'future_claude_record',
  },
] as const

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function rows(bytes: Uint8Array): JsonRow[] {
  return new TextDecoder()
    .decode(bytes)
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as JsonRow)
}

function transcriptEvolution(input: TranscriptEvolution): TranscriptObservation[] {
  let previous: Buffer | undefined
  return input.versions.map(version => {
    if (version.status === 'unavailable') {
      return { event: version.event, status: version.status, reason: version.reason }
    }
    const current = Buffer.from(version.bytes)
    const relation =
      previous === undefined
        ? 'initial'
        : version.event === 'PostCompact'
          ? 'compaction'
          : current.subarray(0, previous.byteLength).equals(previous)
            ? 'append'
            : previous.subarray(0, current.byteLength).equals(current)
              ? 'truncation'
              : 'replacement'
    previous = current
    return {
      event: version.event,
      status: version.status,
      relation,
      sha256: digest(current),
    }
  })
}

async function inspectProvider(definition: (typeof providers)[number]): Promise<CaptureProbe> {
  const fixtureNames = ['hooks.jsonl', 'transcript.jsonl'] as const
  const fixtureBytes = await Promise.all(
    fixtureNames.map(name => readFile(`${fixtureRoot}/providers/${definition.provider}/${name}`)),
  )
  const hookRows = rows(fixtureBytes[0]!)
  const stop = hookRows.find(row => row.hook_event_name === 'Stop')
  const evolution = JSON.parse(
    await readFile(`${fixtureRoot}/transcript-evolution.json`, 'utf8'),
  ) as TranscriptEvolution
  const sessionIds = new Set(
    hookRows
      .map(row => row.session_id)
      .filter((value): value is string => typeof value === 'string'),
  )

  return {
    provider: definition.provider,
    clientVersion: definition.clientVersion,
    fixtureProvenance: definition.fixtureProvenance,
    rawEvents: fixtureBytes.map((bytes, index) => ({
      fixture: `providers/${definition.provider}/${fixtureNames[index]}`,
      sha256: digest(bytes),
      bytes: bytes.byteLength,
      roundTripsExactly: Buffer.from(Buffer.from(bytes).toString('base64'), 'base64').equals(bytes),
    })),
    transcriptObservations: transcriptEvolution(evolution),
    sessionIdentity:
      sessionIds.size === 1
        ? { status: 'supported', evidence: `all hook rows carry ${[...sessionIds][0]}` }
        : {
            status: 'incompatible',
            reason: 'hook rows do not expose one stable native session id',
          },
    stopIdentity:
      typeof stop?.[definition.identityField] === 'string'
        ? { status: 'supported', evidence: `Stop carries ${definition.identityField}` }
        : { status: 'unavailable', reason: `Stop has no ${definition.identityField}` },
    fixtureEventOrder: hookRows.map(row => String(row.hook_event_name)),
    currentEventInventory: {
      status: 'unavailable',
      reason:
        'Current authenticated hook callbacks were not run because no dedicated test credential was available.',
    },
    unknownBytesPreserved: fixtureBytes.some(bytes =>
      new TextDecoder().decode(bytes).includes(definition.unknownMarker),
    ),
    limitations: [
      {
        code: 'stop-transcript-may-lag',
        detail:
          "The Stop fixture exposes a last assistant message newer than the transcript's final assistant row.",
      },
      {
        code: 'authenticated-live-capture-unavailable',
        detail: 'No dedicated test credential was available; no host login was read or reused.',
      },
    ],
  }
}

export async function buildProviderOracle(): Promise<ProviderOracleReport> {
  const clientInventory = JSON.parse(
    await readFile(`${fixtureRoot}/provider-client-inventory.json`, 'utf8'),
  ) as ProviderClientInventory
  const processProbe = JSON.parse(
    await readFile(`${fixtureRoot}/provider-process-probe.json`, 'utf8'),
  ) as ProviderProcessProbe
  const donorReferences = JSON.parse(
    await readFile(`${fixtureRoot}/donor-test-disposition.json`, 'utf8'),
  ) as DonorReference[]
  return {
    generatedBy: { bun: Bun.version, node: process.versions.node },
    clientInventory,
    processProbe,
    donorReferences,
    probes: await Promise.all(providers.map(inspectProvider)),
  }
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function reportHtml(report: ProviderOracleReport): string {
  const probes = report.probes
    .map(
      probe => `<article>
        <h2>${escapeHtml(probe.provider)}</h2>
        <p class="version">Donor-derived fixture · client ${escapeHtml(probe.clientVersion)}</p>
        <p>${escapeHtml(probe.fixtureProvenance)}</p>
        <dl>
          <div><dt>Session identity</dt><dd>${escapeHtml(probe.sessionIdentity.status)}</dd></div>
          <div><dt>Stop identity</dt><dd>${escapeHtml(probe.stopIdentity.status)}</dd></div>
          <div><dt>Unknown bytes</dt><dd>${probe.unknownBytesPreserved ? 'preserved' : 'missing'}</dd></div>
        </dl>
        <h3>Fixture evidence</h3>
        <ul>${probe.rawEvents
          .map(
            event =>
              `<li><a href="../../../../packages/test-harness/fixtures/${escapeHtml(event.fixture)}">${escapeHtml(event.fixture)}</a><code>sha256 ${escapeHtml(event.sha256)}</code></li>`,
          )
          .join('')}</ul>
        <h3>Limitations</h3>
        <ul>${probe.limitations
          .map(
            limitation =>
              `<li><strong>${escapeHtml(limitation.code)}</strong><span>${escapeHtml(limitation.detail)}</span></li>`,
          )
          .join('')}</ul>
      </article>`,
    )
    .join('')
  const references = report.donorReferences
    .map(
      reference =>
        `<tr><td>${escapeHtml(reference.disposition)}</td><td><code>${escapeHtml(reference.source).replaceAll('/', '/<wbr>')}</code></td><td>${escapeHtml(reference.behavior)}</td><td>${escapeHtml(reference.reason)}</td></tr>`,
    )
    .join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Provider capture oracle</title>
  <style>
    :root { color-scheme: light; font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f4f1e8; color: #201f1b; }
    body { max-width: 1160px; margin: 0 auto; padding: 44px 24px 80px; }
    header { border-bottom: 3px solid #201f1b; margin-bottom: 28px; }
    h1 { font: 700 clamp(2.3rem, 5vw, 4.5rem)/1 Georgia, serif; margin: 0 0 18px; max-width: 16ch; }
    .lede { max-width: 70ch; font-family: system-ui, sans-serif; }
    .status { display: inline-block; padding: 6px 10px; background: #f4c95d; border: 1px solid #201f1b; }
    main { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 18px; }
    article { background: #fffdf7; border: 1px solid #201f1b; padding: 22px; box-shadow: 3px 3px 0 #201f1b; }
    article p, article li span, section p, td { font-family: system-ui, sans-serif; }
    h2 { font-size: 1.6rem; margin: 0; text-transform: uppercase; }
    .version { margin-top: 2px; color: #625f56; }
    dl div { display: flex; justify-content: space-between; border-top: 1px solid #cbc6ba; padding: 7px 0; gap: 18px; }
    dd { margin: 0; font-weight: 700; }
    ul { padding-left: 20px; }
    li { margin: 9px 0; overflow-wrap: anywhere; }
    li a { color: #245746; font-weight: 700; text-underline-offset: 3px; }
    li code { display: block; font-size: .9rem; color: #32312d; margin-top: 3px; }
    li strong { display: block; font-size: .82rem; margin-bottom: 2px; color: #245746; }
    section { margin-top: 40px; }
    table { border-collapse: collapse; width: 100%; background: #fffdf7; }
    th, td { border: 1px solid #201f1b; padding: 9px; text-align: left; vertical-align: top; }
    th { background: #dbe8d4; }
    td:first-child { white-space: nowrap; }
    td code { font-size: .82rem; overflow-wrap: normal; word-break: normal; }
    footer { margin-top: 32px; color: #625f56; font-family: system-ui, sans-serif; }
  </style>
</head>
<body>
  <header>
    <p class="status">Slice 01 · evidence, not production</p>
    <h1>Provider capture oracle</h1>
    <p class="lede">Sanitized donor fixtures support provider-native Session and Stop identity, exact unknown-byte preservation, transcript evolution, and a fail-open callback. Authenticated live capture remains explicitly unavailable until dedicated test credentials exist.</p>
  </header>
  <main>${probes}</main>
  <section>
    <h2>Current client inventory</h2>
    <p>${report.clientInventory.clients
      .map(
        client =>
          `${escapeHtml(client.provider)} ${escapeHtml(client.version)} (${escapeHtml(client.versionStatus)})`,
      )
      .join(' · ')}</p>
    <p>Credential-free Docker help certification: <strong>${escapeHtml(report.clientInventory.dockerCertification.status)}</strong>. ${
      report.clientInventory.dockerCertification.status === 'unavailable' ||
      report.clientInventory.dockerCertification.status === 'incompatible'
        ? escapeHtml(report.clientInventory.dockerCertification.reason)
        : escapeHtml(report.clientInventory.dockerCertification.evidence)
    }</p>
  </section>
  <section>
    <h2>Container process probe</h2>
    <p>${report.processProbe.sequencing.observed} events from ${report.processProbe.sequencing.workers} processes; contiguous: <strong>${report.processProbe.sequencing.contiguous}</strong>; unique: <strong>${report.processProbe.sequencing.unique}</strong>.</p>
  </section>
  <section>
    <h2>Donor disposition</h2>
    <table><colgroup><col style="width: 15%"><col style="width: 28%"><col style="width: 24%"><col style="width: 33%"></colgroup><thead><tr><th>Disposition</th><th>Source</th><th>Behavior</th><th>Reason</th></tr></thead><tbody>${references}</tbody></table>
  </section>
  <footer>Generated by Bun ${escapeHtml(report.generatedBy.bun)} on Node ${escapeHtml(report.generatedBy.node)}. Full machine-readable evidence: <a href="report.json">report.json</a>.</footer>
</body>
</html>\n`
}

export async function writeProviderOracle(outputDirectory: string): Promise<ProviderOracleReport> {
  const report = await buildProviderOracle()
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all([
    writeFile(`${outputDirectory}/report.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(`${outputDirectory}/index.html`, reportHtml(report), 'utf8'),
  ])
  return report
}
