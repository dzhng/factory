import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  inspectReviewerEnvironment,
  materializeReviewerCredential,
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
    expect(resolved.sources.codex).toMatchObject({ kind: 'file', mount: { hostPath: codex } })
    expect(resolved.sources.claude).toMatchObject({ kind: 'file', mount: { hostPath: claude } })
  })

  test('discovers an authenticated macOS Claude CLI through Keychain', async () => {
    const home = await mkdtemp(join(tmpdir(), 'factory-reviewer-keychain-home-'))
    const keychainFile = join(home, 'login.keychain-db')
    await writeFile(keychainFile, 'keychain fixture', { mode: 0o600 })
    const calls: string[][] = []
    const resolved = await resolveReviewerAuthentication(
      { HOME: home, FACTORY_CLAUDE_KEYCHAIN_FILE: keychainFile },
      {
        platform: 'darwin',
        runSecurity: async args => {
          calls.push([...args])
          return {
            kind: 'completed',
            exitCode: 0,
            stdout: Buffer.from('keychain item metadata'),
            stderr: Buffer.from(''),
          }
        },
      },
    )

    expect(resolved.inspection.claude).toEqual({ state: 'available' })
    expect(resolved.availability.claude).toBeTrue()
    expect(resolved.sources.claude).toEqual({
      kind: 'macos-keychain',
      service: 'Claude Code-credentials',
      keychainFile,
    })
    expect(calls).toEqual([
      ['find-generic-password', '-s', 'Claude Code-credentials', keychainFile],
    ])
  })

  test('stages only Claude inference auth from Keychain in private attempt state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-reviewer-keychain-stage-'))
    const source = {
      kind: 'macos-keychain' as const,
      service: 'Claude Code-credentials' as const,
      keychainFile: '/host/login.keychain-db',
    }
    const calls: string[][] = []
    const prepared = await materializeReviewerCredential(source, root, {
      runSecurity: async args => {
        calls.push([...args])
        return {
          kind: 'completed',
          exitCode: 0,
          stdout: Buffer.from(
            JSON.stringify({
              claudeAiOauth: {
                accessToken: 'access-test',
                refreshToken: 'refresh-test',
                expiresAt: 123,
              },
              mcpOAuth: { github: { accessToken: 'must-not-cross' } },
            }),
          ),
          stderr: Buffer.from(''),
        }
      },
    })

    expect(JSON.parse(await readFile(prepared.mount.hostPath, 'utf8'))).toEqual({
      claudeAiOauth: {
        accessToken: 'access-test',
        expiresAt: 123,
        refreshToken: 'refresh-test',
      },
    })
    expect((await stat(prepared.mount.hostPath)).mode & 0o777).toBe(0o600)
    expect(prepared.mount.containerPath).toBe('/auth/claude/.credentials.json')
    if (prepared.root === undefined) throw new Error('Keychain credential was not staged')
    expect(prepared.root.startsWith(`${root}/review-auth-`)).toBeTrue()
    expect(calls).toEqual([
      ['find-generic-password', '-w', '-s', 'Claude Code-credentials', '/host/login.keychain-db'],
    ])
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
    expect(resolved.sources.codex).toMatchObject({ kind: 'file', mount: { hostPath: valid } })
    expect(
      resolved.sources.codex?.kind === 'file'
        ? resolved.sources.codex.mount.expectedIdentity
        : undefined,
    ).toMatchObject({
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
      expect(resolved.sources.codex).toBeUndefined()
    }
  })
})
