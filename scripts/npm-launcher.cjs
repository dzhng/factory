#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const target =
  process.platform === 'darwin' && process.arch === 'arm64'
    ? 'darwin-arm64'
    : process.platform === 'linux' &&
        process.arch === 'x64' &&
        process.report.getReport().header.glibcVersionRuntime
      ? 'linux-x64-baseline'
      : undefined
if (!target) {
  console.error('Factory supports macOS arm64 and glibc Linux x64 only.')
  process.exit(1)
}
const result = spawnSync(
  join(__dirname, '..', 'native', target, 'factory'),
  process.argv.slice(2),
  {
    stdio: 'inherit',
  },
)
if (result.error) {
  console.error(`Cannot start Factory: ${result.error.message}`)
  process.exit(1)
}
if (result.signal) process.kill(process.pid, result.signal)
else process.exit(result.status ?? 1)
