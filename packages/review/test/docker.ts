import { mkdir } from 'node:fs/promises'

const repositoryRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const report = process.argv.includes('--report')
const output = `${repositoryRoot}/specs/done/evidence-sanitization/assets/review-publication`
if (report) await mkdir(output, { recursive: true })
const child = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    '1000:1000',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--mount',
    `type=bind,src=${repositoryRoot},dst=/workspace,readonly`,
    '--workdir',
    '/tmp',
    '--env',
    'FACTORY_DOCKER_TEST=1',
    ...(report
      ? [
          '--mount',
          `type=bind,src=${output},dst=/output`,
          '--env',
          'FACTORY_WRITE_PUBLICATION_REPORT=1',
        ]
      : []),
    'oven/bun:1.3.14',
    'bun',
    'test',
    '/workspace/packages/review/test/publication.test.ts',
    ...process.argv.slice(2).filter(argument => argument !== '--report'),
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exit(await child.exited)
