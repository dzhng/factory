import { fileURLToPath } from 'node:url'

import { writeProviderOracle } from './provider-oracle'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const outputDirectory = `${repositoryRoot}/specs/done/factory-v1/assets/provider-capture-oracle`
const report = await writeProviderOracle(outputDirectory)
process.stdout.write(
  `Wrote ${outputDirectory}/index.html and report.json for ${report.probes.length} providers.\n`,
)
