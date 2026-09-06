import { resolve } from 'node:path'

const executable = process.argv[2]
const publishedVersion = process.argv[3]
if (!executable || !publishedVersion)
  throw new Error('usage: run-npm-upgrade.ts <Linux x64 candidate executable> <published version>')

// Networked opt-in journey: real npm replaces a candidate in disposable global prefixes.
// The candidate must embed an older version than the currently published stable release.
const child = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '-v',
    `${resolve(executable)}:/candidate:ro`,
    '-e',
    `EXPECTED_VERSION=${publishedVersion}`,
    '-e',
    'HOME=/tmp/home',
    '-e',
    'npm_config_cache=/tmp/npm-cache',
    'node:24-bookworm-slim',
    'sh',
    '-ec',
    `apt-get update -qq && apt-get install -y -qq git >/dev/null
node -e '
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
fs.mkdirSync(process.env.HOME, { recursive: true });
for (const mode of ["manual", "automatic"]) {
  const root = "/tmp/" + mode + "/lib/node_modules/@dzhng/factory";
  const binary = root + "/native/linux-x64-baseline/factory";
  fs.mkdirSync(root + "/native/linux-x64-baseline", { recursive: true });
  fs.copyFileSync("/candidate", binary);
  fs.chmodSync(binary, 0o755);
  const before = execFileSync(binary, ["version"], { encoding: "utf8" }).trim();
  fs.writeFileSync(root + "/package.json", JSON.stringify({ name: "@dzhng/factory", version: before }));
  execFileSync(binary, mode === "manual" ? ["upgrade"] : ["install"], { stdio: "inherit", cwd: "/tmp" });
  const after = execFileSync(binary, ["version"], { encoding: "utf8" }).trim();
  if (after !== process.env.EXPECTED_VERSION || before === after) throw new Error(mode + ": " + before + " -> " + after);
  if (mode === "automatic") execFileSync(binary, ["uninstall"], { stdio: "inherit" });
  console.log(mode + " npm upgrade verified: " + before + " -> " + after);
}
'`,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)
process.exitCode = await child.exited
