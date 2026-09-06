import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

import { reviewerAdapter } from '@factory/reviewer'

if (!(await Bun.file('/.dockerenv').exists())) throw new Error('Docker-only provider probe')
const digest = createHash('sha256')
  .update(await readFile('/review-input/bundle.json'))
  .digest('hex')
const expected = ['finish_audit', 'submit_audit_summary', 'submit_choice']
for (const provider of ['claude', 'codex'] as const) {
  const home = `/tmp/probe-${provider}`
  await mkdir(home, { recursive: true })
  await writeFile(
    `${home}/auth.json`,
    JSON.stringify({ OPENAI_API_KEY: 'synthetic-provider-probe-token' }),
  )
  const marker = `${home}/ambient-executed`
  const hook = `/usr/local/bin/bun -e 'await Bun.write("${marker}","forbidden")'`
  const foreign = {
    command: '/usr/local/bin/bun',
    args: ['-e', `await Bun.write(${JSON.stringify(marker)}, "forbidden")`],
  }
  await writeFile(
    `${home}/config.toml`,
    'not valid TOML: ambient user configuration must be ignored',
  )
  await writeFile(`${home}/.claude.json`, JSON.stringify({ mcpServers: { foreign } }))
  await writeFile(
    `${home}/settings.json`,
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook }] }] },
      enabledPlugins: { 'ambient@fixture': true },
    }),
  )
  const plugin = `${home}/plugins/cache/fixture/ambient/1`
  await mkdir(`${plugin}/.claude-plugin`, { recursive: true })
  await mkdir(`${plugin}/hooks`, { recursive: true })
  await writeFile(
    `${plugin}/.claude-plugin/plugin.json`,
    JSON.stringify({ name: 'ambient', version: '1.0.0' }),
  )
  await writeFile(
    `${plugin}/hooks/hooks.json`,
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook }] }] } }),
  )
  await writeFile(
    `${home}/plugins/installed_plugins.json`,
    JSON.stringify({
      version: 2,
      plugins: {
        'ambient@fixture': [
          {
            scope: 'user',
            installPath: plugin,
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    }),
  )
  let observed: string[] | undefined
  let stop = () => {}
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const payload = (await request.json().catch(() => ({}))) as {
        tools?: {
          name?: string
          function?: { name?: string }
          type?: string
          tools?: { name?: string }[]
        }[]
      }
      if (payload.tools?.length) {
        observed = payload.tools.flatMap(
          tool =>
            tool.tools?.map(child => `${tool.name ?? ''}__${child.name ?? ''}`) ?? [
              tool.name ?? tool.function?.name ?? JSON.stringify(tool),
            ],
        )
        setTimeout(stop, 10)
      }
      return Response.json(
        {
          error: {
            type: 'authentication_error',
            message: 'Synthetic model boundary: no inference',
          },
        },
        { status: 401 },
      )
    },
  })
  stop = () => process.kill('SIGKILL')
  const invocation = reviewerAdapter(
    { provider, model: provider === 'codex' ? 'gpt-5.4' : 'opus', effort: 'high' },
    digest,
  )
  const argv = [...invocation.argv]
  if (provider === 'codex')
    argv.splice(-1, 0, '--config', `openai_base_url="http://127.0.0.1:${server.port}/v1"`)
  const process = Bun.spawn([provider, ...argv], {
    cwd: invocation.cwd,
    env: {
      ...invocation.environment,
      HOME: home,
      CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: 'synthetic-provider-probe-token',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    },
    stdin: new Blob([invocation.prompt]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => process.kill('SIGKILL'), 20_000)
  const [exit, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  clearTimeout(timer)
  server.stop(true)
  const audit = observed
    ?.filter(name => name.includes('factory_audit'))
    .map(name => name.split('__').at(-1)!)
    .sort()
  const deferred =
    provider === 'codex' &&
    observed?.some(name => name.includes('tool_search') && name.includes('factory_audit'))
  if (
    (!deferred && JSON.stringify(audit) !== JSON.stringify(expected)) ||
    observed?.some(name => name.includes('foreign')) ||
    (await Bun.file(marker).exists()) ||
    (provider === 'claude' && observed?.some(name => /Bash|Edit|Write|WebFetch/.test(name)))
  )
    throw new Error(
      JSON.stringify({
        provider,
        observed,
        exit,
        stdout: stdout.slice(0, 1000),
        stderr: stderr.slice(-2000),
      }),
    )
  console.log(
    JSON.stringify({
      provider,
      authority: 'pinned CLI against synthetic loopback model boundary; no inference',
      tools: deferred ? 'Factory tools registered for deferred discovery' : audit,
    }),
  )
}
