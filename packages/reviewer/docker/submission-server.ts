import { serveAuditSubmissions } from '../src/submission-server'

try {
  await serveAuditSubmissions(process.argv.slice(2))
} catch {
  process.stderr.write('Factory audit submission server unavailable.\n')
  process.exitCode = 1
}
