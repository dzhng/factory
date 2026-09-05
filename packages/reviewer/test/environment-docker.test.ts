import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  inspectReviewerEnvironment,
  resolveReviewerAuthentication,
  type ReviewerCommandResult,
} from '../src/index'

const dockerDescribe = process.env.FACTORY_DOCKER_TEST === '1' ? describe : describe.skip
const dockerAvailable = async (): Promise<ReviewerCommandResult> => ({
  kind: 'completed',
  exitCode: 0,
  stdout: Buffer.from('27.5.1\n'),
  stderr: Buffer.from(''),
})
type InvalidCredentialReason = Exclude<
  Awaited<ReturnType<typeof resolveReviewerAuthentication>>['inspection']['codex']['reason'],
  undefined
>

dockerDescribe('reviewer credential discovery', () => {
  test('uses conventional CLI credentials without Factory-specific setup', async () => {
    expect(process.getuid?.()).not.toBe(0)
    const home = await mkdtemp(join(tmpdir(), 'factory-reviewer-cli-home-'))
    const codex = join(home, '.codex', 'auth.json')
    const claude = join(home, '.claude', '.credentials.json')
    await Promise.all([
      mkdir(join(home, '.codex'), { recursive: true }),
      mkdir(join(home, '.claude'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(codex, '{"tokens":{"access_token":"codex-test"}}\n', { mode: 0o600 }),
      writeFile(claude, '{"claudeAiOauth":{"accessToken":"claude-test"}}\n', { mode: 0o600 }),
    ])

    const resolved = await resolveReviewerAuthentication({ HOME: home })

    expect(resolved.inspection).toEqual({
      codex: { state: 'available' },
      claude: { state: 'available' },
    })
    expect(resolved.availability).toEqual({ codex: true, claude: true })
    expect(resolved.mounts.codex?.hostPath).toBe(codex)
    expect(resolved.mounts.claude?.hostPath).toBe(claude)
  })

  test('mints identity only for a mountable bounded file owned by this non-root user', async () => {
    expect(process.getuid?.()).not.toBe(0)
    const root = await mkdtemp(join(tmpdir(), 'factory-reviewer-auth-'))
    const valid = join(root, 'auth.json')
    await writeFile(valid, '{}\n', { mode: 0o600 })
    const resolved = await resolveReviewerAuthentication({ FACTORY_CODEX_AUTH_FILE: valid })
    expect(resolved.inspection).toEqual({
      codex: { state: 'available' },
      claude: { state: 'unconfigured' },
    })
    expect(resolved.availability).toEqual({ codex: true, claude: false })
    expect(resolved.mounts.codex).toMatchObject({ hostPath: valid })
    expect(resolved.mounts.codex?.expectedIdentity).toMatchObject({
      size: 3,
      uid: process.getuid?.(),
    })
    const publicInspection = await inspectReviewerEnvironment(
      { FACTORY_CODEX_AUTH_FILE: valid },
      dockerAvailable,
    )
    expect(JSON.stringify(publicInspection)).not.toContain(valid)
    expect(publicInspection.credentials.codex).toEqual({ state: 'available' })
  })

  test('classifies refused credential files without minting a mount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-reviewer-auth-invalid-'))
    const ordinary = join(root, 'ordinary.json')
    const linked = join(root, 'linked.json')
    const oversized = join(root, 'oversized.json')
    const unreadable = join(root, 'unreadable.json')
    const comma = join(root, 'auth,comma.json')
    await writeFile(ordinary, '{}\n', { mode: 0o600 })
    await symlink(ordinary, linked)
    await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 })
    await writeFile(unreadable, '{}\n', { mode: 0o600 })
    await chmod(unreadable, 0o000)
    await writeFile(comma, '{}\n', { mode: 0o600 })
    const scenarios: { path: string; reason: InvalidCredentialReason }[] = [
      { path: 'relative.json', reason: 'path-not-absolute' },
      { path: linked, reason: 'missing-or-unsafe' },
      { path: oversized, reason: 'too-large' },
      { path: '/etc/passwd', reason: 'wrong-owner' },
      { path: unreadable, reason: 'unreadable' },
      { path: comma, reason: 'mount-path-unsupported' },
    ]
    for (const scenario of scenarios) {
      const resolved = await resolveReviewerAuthentication({
        FACTORY_CODEX_AUTH_FILE: scenario.path,
      })
      expect(resolved.inspection.codex).toEqual({
        state: 'invalid',
        reason: scenario.reason,
      })
      expect(resolved.availability.codex).toBeFalse()
      expect(resolved.mounts.codex).toBeUndefined()
    }
  })
})
