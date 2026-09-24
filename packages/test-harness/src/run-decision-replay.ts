import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeDecisionReplay } from './decision-replay'

const outputDirectory = await mkdtemp(join(tmpdir(), 'factory-decisions-'))
const report = await writeDecisionReplay(outputDirectory)
process.stdout.write(
  `Wrote ${outputDirectory}/index.html and report.json for ${report.steps.length} fold steps.\n`,
)
