import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
async function command(argv: string[]) {
  const child = Bun.spawn(argv, { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  if ((await child.exited) !== 0) throw new Error('Audit submission probe failed')
}
await command([
  'docker',
  'build',
  '-f',
  'packages/reviewer/docker/Dockerfile',
  '-t',
  'factory-choice-audit-reviewer:local',
  '.',
])

await command([
  'docker',
  'run',
  '--rm',
  '--network',
  'none',
  '--read-only',
  '--user',
  '1000:1000',
  '--tmpfs',
  '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
  '--tmpfs',
  '/out:rw,noexec,nosuid,nodev,size=4m,mode=1777',
  '--mount',
  `type=bind,src=${root},dst=/workspace,readonly`,
  '--mount',
  `type=bind,src=${root}/specs/done/factory-v1/assets/review-plan/complete-bundle,dst=/review-input,readonly`,
  '--entrypoint',
  'bun',
  'factory-choice-audit-reviewer:local',
  '/workspace/packages/test-harness/src/provider-tools-probe.ts',
])
const assets = resolve(root, 'specs/done/factory-v1/assets/review-plan')
const report = JSON.parse(await readFile(resolve(assets, 'report.json'), 'utf8'))
await command([
  'docker',
  'run',
  '--rm',
  '--network',
  'none',
  '--read-only',
  '--user',
  '1000:1000',
  '--tmpfs',
  '/out:rw,noexec,nosuid,nodev,size=4m,mode=1777',
  '--mount',
  `type=bind,src=${root},dst=/workspace,readonly`,
  '--workdir',
  '/out',
  '--env',
  'FACTORY_DOCKER_TEST=1',
  '--entrypoint',
  'bun',
  'factory-choice-audit-reviewer:local',
  '/workspace/packages/test-harness/src/audit-submission-probe.ts',
  '/opt/factory/audit-server.js',
  '/workspace/specs/done/factory-v1/assets/review-plan/complete-bundle',
  report.bundles.complete,
  '/out',
])
