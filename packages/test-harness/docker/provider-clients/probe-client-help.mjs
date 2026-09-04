import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

for (const directory of [process.env.HOME, process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR]) {
  mkdirSync(directory, { recursive: true })
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

const codexVersion = run('codex', ['--version'])
const codexHelp = run('codex', ['exec', '--help'])
const claudeVersion = run('claude', ['--version'])
const claudeHelp = run('claude', ['--help'])

process.stdout.write(
  `${JSON.stringify(
    {
      environment: 'credential-free-docker',
      image: 'node:22-bookworm-slim',
      dockerCertification: {
        status: 'supported',
        evidence:
          'Both pinned clients returned version and help output without credentials or network access.',
      },
      clients: [
        {
          provider: 'codex',
          versionStatus: 'certified',
          version: codexVersion,
          capabilities: {
            ephemeral: codexHelp.includes('--ephemeral'),
            ignoreUserConfig: codexHelp.includes('--ignore-user-config'),
            jsonEvents: codexHelp.includes('--json'),
            outputSchema: codexHelp.includes('--output-schema'),
          },
        },
        {
          provider: 'claude',
          versionStatus: 'certified',
          version: claudeVersion,
          capabilities: {
            bare: claudeHelp.includes('--bare'),
            includeHookEvents: claudeHelp.includes('--include-hook-events'),
            noSessionPersistence: claudeHelp.includes('--no-session-persistence'),
            jsonSchema: claudeHelp.includes('--json-schema'),
          },
        },
      ],
    },
    null,
    2,
  )}\n`,
)
