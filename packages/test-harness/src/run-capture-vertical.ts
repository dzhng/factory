import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const evidenceRoot = await mkdtemp(resolve(tmpdir(), 'factory-capture-vertical-'))

const child = Bun.spawn(['bun', 'run', '--cwd', 'packages/cli', 'test'], {
  cwd: repositoryRoot,
  env: { ...process.env, FACTORY_EVIDENCE_DIR: evidenceRoot },
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(await child.exited)
