import { fileURLToPath } from 'node:url'

import { writeDecisionReplay } from './decision-replay'

const outputDirectory = fileURLToPath(
  new URL('../../../specs/done/factory-v1/assets/decision-replay', import.meta.url),
)
const report = await writeDecisionReplay(outputDirectory)
process.stdout.write(
  `Wrote ${outputDirectory}/index.html and report.json for ${report.steps.length} fold steps.\n`,
)
