import { open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  openRuntimeJournal,
  type DurabilityBoundary,
  type MaterializationClaim,
  type TurnRef,
} from '../src/index.js'

const [root, operation, crashAt] = process.argv.slice(2)
if (!root || !operation || !crashAt)
  throw new Error('root, operation, and crash boundary are required')

const journal = await openRuntimeJournal({
  testRuntimeRoot: root,
  ...(operation === 'complete'
    ? {
        verifyTurn: async (_claim: MaterializationClaim, turn: TurnRef) =>
          new Uint8Array(await readFile(join(root, '.factory', turn.path))),
      }
    : {}),
  onDurabilityBoundary: async boundary => {
    if (boundary !== crashAt) return
    const marker = join(root, `reached-${boundary}`)
    await writeFile(marker, boundary)
    const handle = await open(marker, 'r')
    await handle.sync()
    await handle.close()
    process.kill(process.pid, 'SIGKILL')
  },
})

const stop = {
  provider: 'codex' as const,
  sessionId: 'crash-session',
  generation: 0,
  stopId: 'stop-1',
}
const event = {
  provider: stop.provider,
  sessionId: stop.sessionId,
  generation: stop.generation,
  eventId: operation === 'append-stop' ? 'stop-event' : 'event-1',
  eventKind: operation === 'append-stop' ? ('stop' as const) : ('turn' as const),
  occurredAt: '2026-09-04T00:00:00Z',
  raw: new TextEncoder().encode('crash-payload'),
  ...(operation === 'append-stop' ? { stopId: stop.stopId } : {}),
}

if (operation === 'append' || operation === 'append-stop') {
  await journal.append(event)
} else if (operation === 'claim') {
  await journal.claimStop(stop)
} else if (operation === 'complete') {
  const claim = JSON.parse(process.env.FACTORY_TEST_CLAIM ?? '') as MaterializationClaim
  const turn = JSON.parse(process.env.FACTORY_TEST_TURN ?? '') as TurnRef
  await journal.complete(claim, turn)
} else {
  throw new Error(`Unknown operation: ${operation}`)
}

const _exhaustiveBoundary: DurabilityBoundary = crashAt as DurabilityBoundary
