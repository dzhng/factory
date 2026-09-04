import { openRuntimeJournal } from '../src/index.js'

const [root, workerText, countText] = process.argv.slice(2)
if (!root || !workerText || !countText) throw new Error('root, worker, and count are required')
const worker = Number(workerText)
const count = Number(countText)
const journal = await openRuntimeJournal({ testRuntimeRoot: root })

for (let index = 0; index < count; index += 1) {
  await journal.append({
    provider: worker % 2 === 0 ? 'codex' : 'claude',
    sessionId: `worker-${worker}`,
    generation: 0,
    eventId: `event-${index}`,
    eventKind: 'turn',
    occurredAt: '2026-09-04T00:00:00Z',
    worktreePath: `/repository/worktrees/${worker % 2}`,
    raw: new TextEncoder().encode(`${worker}:${index}`),
  })
}
await journal.close()
