type GitResult = { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }

function git(repositoryRoot: string, ...args: string[]): string {
  const result: GitResult = Bun.spawnSync(['git', ...args], {
    cwd: repositoryRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim())
  return new TextDecoder().decode(result.stdout).trim()
}

/** Binds release identity to the exact clean checkout being compiled. */
export function verifiedSourceRevision(repositoryRoot: string, requested?: string): string {
  const head = git(repositoryRoot, 'rev-parse', 'HEAD')
  if (!/^[0-9a-f]{40}$/.test(head)) throw new TypeError('release HEAD must be a Git SHA')
  if (requested !== undefined && requested !== head) {
    throw new Error('release revision does not match the source checkout')
  }
  if (git(repositoryRoot, 'status', '--porcelain', '--untracked-files=all').length !== 0) {
    throw new Error('release builds require a clean worktree')
  }
  return head
}
