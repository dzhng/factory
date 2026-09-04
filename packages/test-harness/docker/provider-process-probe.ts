import { Database } from 'bun:sqlite'

const [, , mode, databasePath] = process.argv

if (mode === '--worker') {
  const database = new Database(databasePath, { create: true })
  database.exec('PRAGMA busy_timeout = 10000')
  const insert = database.prepare('INSERT INTO events DEFAULT VALUES')
  database.transaction(() => {
    for (let index = 0; index < 25; index += 1) insert.run()
  })()
  database.close()
  process.exit(0)
}

const path = '/state/events.sqlite'
const database = new Database(path, { create: true })
database.exec('CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT)')
database.close()

const children = Array.from({ length: 8 }, () =>
  Bun.spawn([process.execPath, import.meta.path, '--worker', path], {
    stderr: 'pipe',
    stdout: 'pipe',
  }),
)
const statuses = await Promise.all(children.map(child => child.exited))
if (statuses.some(status => status !== 0)) throw new Error('a sequencing worker failed')

const inspection = new Database(path, { readonly: true })
const sequences = inspection
  .query<{ sequence: number }, []>('SELECT sequence FROM events ORDER BY sequence')
  .all()
  .map(({ sequence }) => sequence - 1)
inspection.close()
const expected = Array.from({ length: 200 }, (_, index) => index)

process.stdout.write(
  `${JSON.stringify(
    {
      environment: 'credential-free-docker',
      sequencing: {
        workers: 8,
        recordsPerWorker: 25,
        observed: sequences.length,
        contiguous: sequences.every((sequence, index) => sequence === expected[index]),
        unique: new Set(sequences).size === sequences.length,
      },
      responseProvenance: 'donor-wrapper-fixture',
      hookResponses: ['codex', 'claude'].flatMap(provider =>
        ['captured', 'capture-failed'].map(outcome => ({
          provider,
          outcome,
          exitCode: 0,
          stdout: '{}\n',
        })),
      ),
    },
    null,
    2,
  )}\n`,
)
