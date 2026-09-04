import { openRuntimeJournal } from '../src/index.js'

const root = process.argv[2]
if (!root) throw new Error('runtime root required')
const journal = await openRuntimeJournal({ testRuntimeRoot: root })
const claim = await journal.claimStop({
  provider: 'codex',
  sessionId: 'crash-session',
  generation: 0,
  stopId: 'stop-1',
})
await journal.close()
process.stdout.write(JSON.stringify(claim))
