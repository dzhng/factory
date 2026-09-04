import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [root, workerText, countText, crash] = process.argv.slice(2)
if (!root || !workerText || !countText) throw new Error('root, worker, and count are required')
const worker = Number(workerText)
const count = Number(countText)
await mkdir(root, { recursive: true })

for (let index = 0; index < count; index += 1) {
  const lock = join(root, 'lock')
  while (true) {
    try {
      await mkdir(lock)
      break
    } catch {
      await Bun.sleep(1)
    }
  }
  if (crash === 'crash') process.kill(process.pid, 'SIGKILL')
  const counter = join(root, 'counter')
  const current = Number(await readFile(counter, 'utf8').catch(() => '0'))
  const temporary = join(root, `counter-${worker}-${index}`)
  await writeFile(temporary, String(current + 1))
  const handle = await open(temporary, 'r')
  await handle.sync()
  await handle.close()
  await rename(temporary, counter)
  await writeFile(join(root, `${current.toString().padStart(20, '0')}.row`), `${worker}:${index}`)
  await rm(lock, { recursive: true })
}
