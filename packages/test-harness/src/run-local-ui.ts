import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serveLocalUi } from '@factory/web'
import { chromium, type Browser } from 'playwright-core'

import { localUiFixtures } from './local-ui-fixtures'

const repositoryRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const outputRoot = join(repositoryRoot, 'specs/done/factory-v1/assets/localhost-ui')
const image = 'factory-local-ui-test:local'
const check = process.argv.includes('--check') || process.env.FACTORY_LOCAL_UI_CHECK === '1'

if (process.env.FACTORY_LOCAL_UI_DOCKER !== '1') {
  const build = Bun.spawn(
    [
      'docker',
      'build',
      '--tag',
      image,
      '--file',
      join(repositoryRoot, 'packages/test-harness/docker/local-ui/Dockerfile'),
      repositoryRoot,
    ],
    { cwd: repositoryRoot, stdout: 'inherit', stderr: 'inherit' },
  )
  if ((await build.exited) !== 0) process.exit(1)
  const run = Bun.spawn(
    [
      'docker',
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,nodev,size=512m',
      '--mount',
      `type=bind,src=${repositoryRoot},dst=/workspace`,
      '--workdir',
      '/workspace',
      '--env',
      'FACTORY_LOCAL_UI_DOCKER=1',
      '--env',
      'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
      ...(check ? ['--env', 'FACTORY_LOCAL_UI_CHECK=1'] : []),
      image,
      'bun',
      'run',
      'packages/test-harness/src/run-local-ui.ts',
    ],
    { cwd: repositoryRoot, stdout: 'inherit', stderr: 'inherit' },
  )
  process.exit(await run.exited)
}

const captureRoot = await mkdtemp(join(tmpdir(), 'factory-local-ui-'))
const screenshots = join(captureRoot, 'screenshots')
await mkdir(screenshots, { recursive: true })
const browser: Browser = await chromium.launch({ headless: true })
const captures = new Set(['active-capture', 'exact-pr', 'partial-coverage', 'canonical-decisions'])
const report: {
  schemaVersion: 1
  scenarios: { id: string; description: string; assertions: string[] }[]
  screenshots: { file: string; sha256: string; bytes: number }[]
} = { schemaVersion: 1, scenarios: [], screenshots: [] }

try {
  for (const fixture of localUiFixtures()) {
    const decisionActions: unknown[] = []
    const coverageActions: unknown[] = []
    const handle = await serveLocalUi({
      host: '127.0.0.1',
      snapshot: async () => fixture.snapshot,
      actions: {
        async appendDecision(action) {
          decisionActions.push(action)
        },
        async acceptCoverage(reviewId) {
          coverageActions.push(reviewId)
        },
      },
    })
    const assertions: string[] = []
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
        reducedMotion: 'reduce',
      })
      const page = await context.newPage()
      await page.goto(handle.origin)
      await page.locator('#app[data-ready]').waitFor()
      if (fixture.snapshot.state === 'ready') {
        await page.getByRole('heading', { name: 'Factory', exact: true }).waitFor()
        await page.getByRole('navigation', { name: 'Jump to evidence section' }).waitFor()
        assertions.push('named heading and navigation')
        if (fixture.id === 'exact-pr') {
          await page.getByText('Exact association').waitFor()
          assertions.push('exact association label')
        }
        if (fixture.id === 'ambiguous-pr') {
          await page
            .getByText(/No exact Session association/)
            .first()
            .waitFor()
          assertions.push('ambiguous association label')
        }
        if (fixture.id === 'partial-coverage') {
          await page.getByText('Result · partial', { exact: true }).first().waitFor()
          assertions.push('partial review label')
        }
        if (fixture.id === 'canonical-decisions') {
          await page.getByText('State · pending-supersession', { exact: true }).waitFor()
          await page.getByText('Human · confirmed', { exact: true }).waitFor()
          assertions.push('canonical confirmation and pending change labels')
          await page.getByRole('button', { name: 'Confirm', exact: true }).first().click()
          await page.getByText('Action recorded in append-only Factory history.').waitFor()
          if (
            decisionActions.length !== 1 ||
            (decisionActions[0] as { kind?: string }).kind !== 'confirm'
          )
            throw new Error('decision intent did not cross the browser action seam')
          assertions.push('decision action intent')
          await page.locator('.status').evaluate(node => node.remove())
        }
        if (fixture.id === 'partial-coverage') {
          if ((await page.locator('img').count()) !== 0)
            throw new Error('review text created markup')
          const responseText = await page.locator('pre.response').textContent()
          if (!responseText?.includes('<img src=x onerror=alert'))
            throw new Error('review text was not preserved literally')
          assertions.push('repository text rendered literally')
          await page.getByRole('button', { name: 'Record reviewed-partial coverage' }).click()
          await page.getByText('Action recorded in append-only Factory history.').waitFor()
          if (coverageActions.length !== 1)
            throw new Error('coverage intent did not cross the browser action seam')
          assertions.push('partial coverage action intent')
          await page.locator('.status').evaluate(node => node.remove())
        }
        const keyboardPage = await context.newPage()
        await keyboardPage.goto(handle.origin)
        await keyboardPage.locator('#app[data-ready]').waitFor()
        await keyboardPage.keyboard.press('Tab')
        if ((await keyboardPage.evaluate('document.activeElement?.className')) !== 'skip-link')
          throw new Error('skip link is not first in keyboard order')
        await keyboardPage.close()
        assertions.push('keyboard skip link')
      } else {
        await page.getByRole('heading', { name: fixture.snapshot.title }).waitFor()
        assertions.push('read-only failure heading')
      }
      if (captures.has(fixture.id)) {
        const focusSection = {
          'exact-pr': '#pull-requests',
          'partial-coverage': '#reviews',
          'canonical-decisions': '#decisions',
        }[fixture.id]
        for (const viewport of [
          { name: 'wide', width: 1440, height: 1000 },
          { name: 'narrow', width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport)
          await page.evaluate('window.scrollTo(0, 0)')
          if (focusSection !== undefined) {
            await page.evaluate(
              `document.querySelector(${JSON.stringify(focusSection)}).scrollIntoView({block:'start'})`,
            )
          }
          await page.evaluate('document.activeElement?.blur()')
          if (
            await page.evaluate(
              'document.documentElement.scrollWidth > document.documentElement.clientWidth',
            )
          )
            throw new Error(`${fixture.id} overflows at ${viewport.name}`)
          const file = `${fixture.id}--${viewport.name}.png`
          const path = join(screenshots, file)
          await page.screenshot({ path, animations: 'disabled' })
          const bytes = await readFile(path)
          report.screenshots.push({
            file,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.byteLength,
          })
        }
      }
      report.scenarios.push({ id: fixture.id, description: fixture.description, assertions })
      await context.close()
    } finally {
      await handle.stop()
    }
  }
} finally {
  await browser.close()
}

if (check) {
  for (const item of report.screenshots) {
    const current = await readFile(join(screenshots, item.file))
    const baseline = await readFile(join(outputRoot, 'screenshots', item.file))
    if (!current.equals(baseline)) throw new Error(`localhost UI screenshot changed: ${item.file}`)
  }
  process.stdout.write(
    `Matched ${report.screenshots.length} screenshots across ${report.scenarios.length} scenarios.\n`,
  )
} else {
  await mkdir(join(outputRoot, 'screenshots'), { recursive: true })
  for (const item of report.screenshots) {
    await Bun.write(
      join(outputRoot, 'screenshots', item.file),
      Bun.file(join(screenshots, item.file)),
    )
  }
  await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const figures = report.screenshots
    .map(
      item =>
        `<figure><img src="screenshots/${item.file}" alt="${item.file}"><figcaption>${item.file}</figcaption></figure>`,
    )
    .join('\n')
  await writeFile(
    join(outputRoot, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Factory localhost UI</title><style>body{font-family:system-ui;margin:2rem;background:#eee}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1rem}figure{margin:0;background:white;padding:1rem}img{max-width:100%;height:auto}figcaption{margin-top:.5rem}</style><h1>Factory localhost UI</h1><main>${figures}</main>`,
  )
  process.stdout.write(
    `Captured ${report.screenshots.length} screenshots across ${report.scenarios.length} scenarios.\n`,
  )
}
