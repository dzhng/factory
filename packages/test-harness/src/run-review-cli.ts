import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runFactoryCli } from '@factory/cli'
import { canonicalJson } from '@factory/contract'

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

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'factory-review-cli-'))
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
    const authRoot = join(root, 'dedicated-auth')
    await mkdir(authRoot)
    const auth = join(authRoot, 'auth.json')
    await writeFile(auth, '{}\n', { mode: 0o444 })
    await chmod(auth, 0o444)
    const image = await command(
      ['docker', 'build', '-q', resolve(import.meta.dir, '../docker/reviewer-isolation')],
      root,
    )
    const environment = {
      ...process.env,
      FACTORY_CODEX_REVIEW_MODEL: 'gpt-test',
      FACTORY_CODEX_REVIEW_EFFORT: 'high',
      FACTORY_CLAUDE_REVIEW_MODEL: 'claude-test',
      FACTORY_CLAUDE_REVIEW_EFFORT: 'high',
      FACTORY_CODEX_AUTH_FILE: auth,
      FACTORY_REVIEWER_IMAGE_DIGEST: image,
    }
    for (const invalid of [
      ['review', '--pr', '42x'],
      ['review', '--full', '--force'],
      ['review', '--fail-on', 'urgent'],
    ]) {
      const errors: string[] = []
      const code = await runFactoryCli(invalid, {
        cwd: root,
        environment,
        output: { stdout: value => errors.push(value), stderr: value => errors.push(value) },
      })
      if (code !== 1 || errors.length === 0)
        throw new Error(`factory review accepted invalid flags: ${invalid.join(' ')}`)
    }
    const firstOutputs: string[][] = [[], []]
    const firstCodes = await Promise.all(
      firstOutputs.map(
        async collected =>
          await runFactoryCli(['review'], {
            cwd: root,
            environment,
            output: {
              stdout: value => collected.push(value),
              stderr: value => collected.push(value),
            },
          }),
      ),
    )
    if (firstCodes.some(code => code !== 0))
      throw new Error(`concurrent factory review failed: ${firstOutputs.flat().join('')}`)
    const firstResults = firstOutputs.map(
      output => JSON.parse(output.join('')) as Record<string, string>,
    )
    const accepted = firstResults.find(result => result.disposition === 'complete')
    const noOp = firstResults.find(result => result.status === 'already-reviewed')
    if (accepted === undefined || noOp === undefined)
      throw new Error(`concurrent review did not converge: ${JSON.stringify(firstResults)}`)
    const secondOutput: string[] = []
    const second = await runFactoryCli(['review'], {
      cwd: root,
      environment,
      output: {
        stdout: value => secondOutput.push(value),
        stderr: value => secondOutput.push(value),
      },
    })
    if (second !== 0 || !secondOutput.join('').includes('already-reviewed'))
      throw new Error(`factory review retry was not a no-op: ${secondOutput.join('')}`)
    process.stdout.write(
      canonicalJson({ schemaVersion: 1, first: accepted.disposition, retry: 'already-reviewed' }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
