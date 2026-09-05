#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { liveCaptureCompleted } from '../../src/live-capture-contract'

// Test-only provider shim: the production executor still owns mounts and credentials.
const provider = process.env.CODEX_HOME === '/auth/codex' ? 'codex' : 'claude'
const client =
  provider === 'codex'
    ? ['node', '/usr/local/lib/node_modules/@openai/codex/bin/codex.js']
    : ['/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe']

async function command(argv: string[], input?: string) {
  const child = Bun.spawn(argv, {
    cwd: '/tmp/capture-repository',
    env: process.env,
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 120_000)
  async function readOutput(stream: ReadableStream<Uint8Array>) {
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > 1024 * 1024) {
        child.kill('SIGKILL')
        throw new Error('capture probe process output exceeded bound')
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      readOutput(child.stdout),
      readOutput(child.stderr),
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(deadline)
  }
}

if (process.argv.includes('--version')) {
  const child = Bun.spawn([...client, '--version'], { stdout: 'inherit', stderr: 'inherit' })
  process.exit(await child.exited)
}

async function main() {
  await mkdir('/tmp/capture-repository', { recursive: true })
  const configHome = provider === 'codex' ? '/auth/codex' : '/auth/claude'
  Object.assign(process.env, {
    HOME: '/tmp/capture-home',
    XDG_CONFIG_HOME: '/tmp/capture-home/config',
    XDG_STATE_HOME: '/tmp/capture-home/state',
    CODEX_HOME: provider === 'codex' ? configHome : '/tmp/capture-home/codex',
    CLAUDE_CONFIG_DIR: provider === 'claude' ? configHome : '/tmp/capture-home/claude',
  })
  await mkdir('/tmp/capture-home', { recursive: true })
  async function succeed(argv: string[], input?: string) {
    const result = await command(argv, input)
    if (result.code !== 0)
      throw new Error(
        `capture oracle command ${argv[0]} failed (${result.code}): ${result.stderr.slice(0, 1000)} ${result.stdout.slice(-1500)}`,
      )
    return result.stdout
  }
  await succeed(['git', 'init', '-b', 'main'])
  await writeFile('/tmp/capture-repository/fixture.txt', 'factory-live-capture-fixture\n')
  await succeed(['factory', 'init', '--canonical-branch', 'main'])
  await succeed(['factory', 'install', '--executable', '/usr/local/bin/factory'])

  const prompt =
    'Read fixture.txt using your read tool, then reply with exactly FACTORY_CAPTURE_OK. Do not change any files.'
  const argv =
    provider === 'codex'
      ? [
          ...client,
          'exec',
          '--json',
          '--sandbox',
          'danger-full-access',
          '--dangerously-bypass-hook-trust',
          '--model',
          'gpt-5.6-sol',
          '--config',
          'model_reasoning_effort=low',
          '-',
        ]
      : [
          ...client,
          '--print',
          '--verbose',
          '--output-format',
          'stream-json',
          '--include-hook-events',
          '--tools',
          'Read',
          '--permission-mode',
          'dontAsk',
          '--permission-prompts',
          'none',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--model',
          'claude-opus-5',
          '--effort',
          'low',
        ]
  const first = await succeed(argv, prompt)
  async function files(path: string): Promise<string[]> {
    const result: string[] = []
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) result.push(...(await files(child)))
      else if (entry.isFile()) result.push(child)
    }
    return result
  }
  let all = await files('/tmp/capture-repository/.factory')
  const identityPath = all.find(path => path.endsWith('/identity.json'))
  if (identityPath === undefined)
    throw new Error('real provider did not materialize a captured Session')
  const firstIdentity = JSON.parse(await readFile(identityPath, 'utf8'))
  const resumeArgv =
    provider === 'codex'
      ? [
          ...client,
          'exec',
          'resume',
          '--json',
          '--dangerously-bypass-approvals-and-sandbox',
          '--dangerously-bypass-hook-trust',
          '--model',
          'gpt-5.6-sol',
          '--config',
          'model_reasoning_effort=low',
          firstIdentity.nativeSessionId,
          '-',
        ]
      : [...argv, '--resume', firstIdentity.nativeSessionId]
  const second = await succeed(
    resumeArgv,
    'Reply with exactly FACTORY_RESUME_OK. Do not use tools.',
  )
  all = await files('/tmp/capture-repository/.factory')
  const manifests = await Promise.all(
    all
      .filter(path => /\/turns\/[^/]+\/manifest.json$/.test(path))
      .map(async path => JSON.parse(await readFile(path, 'utf8'))),
  )
  const identities = await Promise.all(
    all
      .filter(path => path.endsWith('/identity.json'))
      .map(async path => JSON.parse(await readFile(path, 'utf8'))),
  )
  const rootManifest = '/tmp/capture-repository/.factory/manifest.json'
  const rootRecord = JSON.parse(await readFile(rootManifest, 'utf8'))
  await writeFile(rootManifest, JSON.stringify({ ...rootRecord, minimumReaderVersion: '999.0.0' }))
  async function factoryFingerprint() {
    const hash = createHash('sha256')
    for (const path of (await files('/tmp/capture-repository/.factory')).sort()) {
      hash.update(path).update(await readFile(path))
    }
    return hash.digest('hex')
  }
  const beforeFault = await factoryFingerprint()
  process.env.FACTORY_CAPTURE_PROBE_PHASE = 'reader-refusal'
  const fault = await succeed(
    resumeArgv,
    'Reply with exactly FACTORY_FAIL_OPEN_OK. Do not use tools.',
  )
  const faultPreservedRepository = beforeFault === (await factoryFingerprint())
  const callbacks = (await readFile('/tmp/capture-callbacks.jsonl', 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  const result = {
    provider,
    firstCompleted: liveCaptureCompleted(provider, first, 'FACTORY_CAPTURE_OK'),
    secondCompleted: liveCaptureCompleted(provider, second, 'FACTORY_RESUME_OK'),
    faultCompleted: liveCaptureCompleted(provider, fault, 'FACTORY_FAIL_OPEN_OK'),
    faultPreservedRepository,
    identities,
    manifests,
    callbacks,
  }
  // This bounded response is an oracle result, not a semantic review or acceptance record.
  if (provider === 'codex') await writeFile('/out/response.txt', JSON.stringify(result))
  else process.stdout.write(JSON.stringify(result))
}
try {
  await main()
} catch (error) {
  const result = JSON.stringify({
    provider,
    error: error instanceof Error ? error.message : 'probe failed',
  })
  if (provider === 'codex') await writeFile('/out/response.txt', result)
  else process.stdout.write(result)
}
