#!/usr/bin/env bun
import { runFactoryCli } from './index'

const code = await runFactoryCli(process.argv.slice(2))
process.exitCode = code
