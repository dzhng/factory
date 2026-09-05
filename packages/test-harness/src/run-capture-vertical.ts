import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const evidenceRoot = resolve(repositoryRoot, 'specs/done/factory-v1/assets/capture-vertical')
await rm(evidenceRoot, { recursive: true, force: true })
await mkdir(evidenceRoot, { recursive: true })

const child = Bun.spawn(['bun', 'run', '--cwd', 'packages/cli', 'test'], {
  cwd: repositoryRoot,
  env: { ...process.env, FACTORY_EVIDENCE_DIR: evidenceRoot },
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(await child.exited)
