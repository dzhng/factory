import { resolve } from 'node:path'

const archive = process.argv[2]
const version = process.argv[3]
if (!archive || !version) throw new Error('usage: run-npm-install.ts <package.tgz> <version>')
const child = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--network',
    'none',
    '-v',
    `${resolve(archive)}:/package.tgz:ro`,
    '-e',
    `EXPECTED_VERSION=${version}`,
    '-e',
    'HOME=/tmp/home',
    'node:24-bookworm-slim',
    'sh',
    '-ec',
    `mkdir -p "$HOME"
npm install --global --prefix /tmp/npm --cache /tmp/cache --offline --ignore-scripts --no-audit --no-fund /package.tgz
/tmp/npm/bin/factory version > /tmp/version.txt
node -e 'const fs = require("fs"); const value = fs.readFileSync("/tmp/version.txt", "utf8").trim(); if (value !== process.env.EXPECTED_VERSION) throw new Error(value); console.log(value)'
if /tmp/npm/bin/factory not-a-command; then exit 1; fi
/tmp/npm/bin/factory install > /tmp/install.json
node -e 'const fs = require("fs"); const value = JSON.parse(fs.readFileSync("/tmp/install.json")); const expected = "/tmp/npm/lib/node_modules/@dzhng/factory/native/linux-x64-baseline/factory"; if (value.executable !== expected) throw new Error(JSON.stringify(value))'
/tmp/npm/bin/factory uninstall`,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exitCode = await child.exited
