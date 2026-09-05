import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { canonicalJson, newRecordId } from '@factory/contract'

const cliPackageRoot = resolve(import.meta.dir, '../../cli')
const factoryProgram = join(cliPackageRoot, 'dist/factory.js')

async function command(args: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${args[0]} failed: ${stderr.trim()}`)
  return stdout.trim()
}

const ghProgram = `#!/usr/bin/env bun
const args = process.argv.slice(2)
const head = process.env.FACTORY_TEST_PR_HEAD
if (!/^[0-9a-f]{40}$/.test(head ?? '')) process.exit(2)
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify({id:'R_base',nameWithOwner:'owner/repo',url:'https://github.com/owner/repo'}))
} else if (args[0] === 'pr' && args[1] === 'diff') {
  console.log('diff --git a/file.ts b/file.ts\\\\n+review')
} else if (args[0] === 'api' && args.includes('graphql')) {
  console.log(JSON.stringify({data:{repository:{id:'R_base',nameWithOwner:'owner/repo',url:'https://github.com/owner/repo',pullRequest:{id:'PR_42',url:'https://github.com/owner/repo/pull/42',number:42,state:'OPEN',mergedAt:null,baseRefName:'main',baseRefOid:'1111111111111111111111111111111111111111',headRefName:'feature',headRefOid:head,updatedAt:'2026-09-05T00:00:00Z',headRepository:{id:'R_base',nameWithOwner:'owner/repo',url:'https://github.com/owner/repo'},commits:{nodes:[{commit:{oid:head}}],pageInfo:{hasNextPage:false,endCursor:null}}}}}}))
} else process.exit(3)
`

async function review(
  root: string,
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, factoryProgram, 'review', '--pr', '42', '--force'], {
    cwd: root,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`PR review failed: ${stdout}${stderr}`)
  return JSON.parse(stdout) as Record<string, unknown>
}

async function main() {
  await command(['bun', 'run', 'build'], cliPackageRoot)
  const root = await mkdtemp(join(tmpdir(), 'factory-review-pr-cli-'))
  try {
    await command(['git', 'init', '-q'], root)
    const asset = resolve(
      import.meta.dir,
      '../../../specs/factory-v1/assets/review-plan/complete-bundle',
    )
    await cp(join(asset, '.factory'), join(root, '.factory'), { recursive: true })
    await writeFile(
      join(root, '.factory', 'manifest.json'),
      canonicalJson({
        schemaVersion: 1,
        format: 'factory-repository',
        minimumReaderVersion: '0.1.0',
        repositoryId: 'repo_review_lab',
        createdAt: '2026-09-05T00:00:00Z',
      }),
    )
    await writeFile(
      join(root, '.factory', 'config.json'),
      canonicalJson({ schemaVersion: 1, reviewer: 'auto' }),
    )
    const bin = join(root, 'bin')
    await mkdir(bin)
    const gh = join(bin, 'gh')
    await writeFile(gh, ghProgram)
    await chmod(gh, 0o755)
    const auth = join(root, 'auth.json')
    await writeFile(auth, '{}\n', { mode: 0o444 })
    const image = await command(
      ['docker', 'build', '-q', resolve(import.meta.dir, '../docker/reviewer-isolation')],
      root,
    )
    const baseEnvironment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FACTORY_CODEX_REVIEW_MODEL: 'gpt-test',
      FACTORY_CODEX_REVIEW_EFFORT: 'high',
      FACTORY_CLAUDE_REVIEW_MODEL: 'claude-test',
      FACTORY_CLAUDE_REVIEW_EFFORT: 'high',
      FACTORY_CODEX_AUTH_FILE: auth,
      FACTORY_REVIEWER_IMAGE_DIGEST: image,
    }
    const originalHead = '0000000000000000000000000000000000000064'
    const first = await review(root, { ...baseEnvironment, FACTORY_TEST_PR_HEAD: originalHead })
    const factoryRoot = join(root, '.factory')
    const firstAssociationPath = await Array.fromAsync(
      new Bun.Glob('pull-requests/**/associations/*/*.json').scan({ cwd: factoryRoot }),
    ).then(paths => paths.find(path => !path.includes('/batches/')))
    if (firstAssociationPath === undefined)
      throw new Error('first PR association was not persisted')
    const firstAssociation = JSON.parse(
      await readFile(join(factoryRoot, firstAssociationPath), 'utf8'),
    ) as Record<string, unknown>
    const orphanId = newRecordId('association')
    await writeFile(
      join(factoryRoot, firstAssociationPath.replace(/[^/]+\.json$/, `${orphanId}.json`)),
      canonicalJson({ ...firstAssociation, evidenceId: orphanId }),
    )
    await rm(
      join(
        factoryRoot,
        'sessions/codex/session-review-lab/turns/turn_00000000010000000000000001/transcript.jsonl',
      ),
    )
    await new Promise(resolve => setTimeout(resolve, 5))
    const incompleteGraph = await review(root, {
      ...baseEnvironment,
      FACTORY_TEST_PR_HEAD: originalHead,
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    const replacementHead = '0000000000000000000000000000000000000065'
    const second = await review(root, { ...baseEnvironment, FACTORY_TEST_PR_HEAD: replacementHead })
    const records: unknown[] = []
    const associationRoot = join(root, '.factory', 'pull-requests')
    for await (const path of new Bun.Glob('**/associations/**/*.json').scan({
      cwd: associationRoot,
    })) {
      records.push(JSON.parse(await readFile(join(associationRoot, path), 'utf8')))
    }
    const invalidations = records.filter(
      (value): value is { kind: string; invalidates: string } =>
        typeof value === 'object' &&
        value !== null &&
        (value as { kind?: string }).kind === 'invalidation',
    )
    const batches = records.filter(
      value =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { batchId?: unknown }).batchId === 'string',
    )
    if (
      first.disposition !== 'complete' ||
      !['complete', 'partial'].includes(String(incompleteGraph.disposition)) ||
      !['complete', 'partial'].includes(String(second.disposition)) ||
      invalidations.length !== 1 ||
      invalidations[0]!.invalidates !== firstAssociation.evidenceId ||
      invalidations[0]!.invalidates === orphanId ||
      batches.length !== 2
    )
      throw new Error(
        'force-push review did not preserve and invalidate verified association evidence',
      )
    process.stdout.write(
      canonicalJson({
        schemaVersion: 1,
        first: first.disposition,
        incompleteGraph: incompleteGraph.disposition,
        second: second.disposition,
        invalidations: invalidations.length,
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
