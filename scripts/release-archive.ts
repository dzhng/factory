export function createReleaseArchive(directory: string, files: readonly string[]): Uint8Array {
  const result = Bun.spawnSync(['tar', '--format=ustar', '-czf', '-', '-C', directory, ...files], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim())
  return result.stdout
}
