import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { presentDecisions } from '@factory/domain'
import { serveLocalUi } from '@factory/web'
import { chromium, type Browser } from 'playwright-core'

import { choicePresentationFixture, presentationDecisions } from './choice-presentation-fixtures'
import { localUiFixtures } from './local-ui-fixtures'

const repositoryRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const outputRoot = join(repositoryRoot, 'packages/test-harness/fixtures/local-ui')
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
const files: string[] = []
const choices = choicePresentationFixture()
const fixtures = [
  ...localUiFixtures(),
  { id: 'choices', snapshot: choices },
  {
    id: 'choices-readonly',
    snapshot: {
      ...choices,
      canonicalBranch: null,
      decisions: presentDecisions({
        unclassified: presentationDecisions().lineages.flatMap(lineage =>
          lineage.observations.map(item => item.observation),
        ),
      }),
    },
  },
]

try {
  for (const fixture of fixtures) {
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
        if (fixture.id === 'exact-pr') {
          await page.getByText('Exact association').waitFor()
        }
        if (fixture.id === 'ambiguous-pr') {
          await page
            .getByText(/No exact Session association/)
            .first()
            .waitFor()
        }
        if (fixture.id === 'partial-coverage') {
          await page.getByText('Result · partial', { exact: true }).first().waitFor()
        }
        if (fixture.id === 'canonical-decisions') {
          await page.getByText('State · pending-supersession', { exact: true }).waitFor()
          await page.getByText('Human · confirmed', { exact: true }).waitFor()
          await page
            .getByRole('button', { name: 'Confirm recorded choice', exact: true })
            .first()
            .click()
          await page.getByText('Action recorded in append-only Factory history.').waitFor()
          if (
            decisionActions.length !== 1 ||
            (decisionActions[0] as { kind?: string }).kind !== 'confirm'
          )
            throw new Error('decision intent did not cross the browser action seam')
          await page.locator('.status').evaluate(node => node.remove())
        }
        if (fixture.id === 'partial-coverage') {
          if ((await page.locator('img').count()) !== 0)
            throw new Error('review text created markup')
          const responseText = await page.locator('.audit-summary').textContent()
          if (!responseText?.includes('<img src=x onerror=alert'))
            throw new Error('review text was not preserved literally')
          await page.getByRole('button', { name: 'Record reviewed-partial coverage' }).click()
          await page.getByText('Action recorded in append-only Factory history.').waitFor()
          if (coverageActions.length !== 1)
            throw new Error('coverage intent did not cross the browser action seam')
          await page.locator('.status').evaluate(node => node.remove())
        }
        const keyboardPage = await context.newPage()
        await keyboardPage.goto(handle.origin)
        await keyboardPage.locator('#app[data-ready]').waitFor()
        await keyboardPage.keyboard.press('Tab')
        if ((await keyboardPage.evaluate('document.activeElement?.className')) !== 'skip-link')
          throw new Error('skip link is not first in keyboard order')
        await keyboardPage.close()
      } else {
        await page.getByRole('heading', { name: fixture.snapshot.title }).waitFor()
      }
      if (captures.has(fixture.id) || fixture.id.startsWith('choices')) {
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
          if (fixture.id === 'choices') {
            for (const index of [0, 2]) {
              decisionActions.length = 0
              await page
                .locator(`[data-choice="presentation.choice-${index}"]`)
                .getByRole('button', { name: 'Confirm recorded choice', exact: true })
                .click()
              await page.getByText('Action recorded in append-only Factory history.').waitFor()
              assert.equal(
                (decisionActions[0] as { targetObservationId: string }).targetObservationId,
                presentationDecisions().lineages[index]!.observations[0]!.observation.observationId,
              )
              await page.locator('.status').evaluate(node => node.remove())
            }
            for (const lineage of presentationDecisions().lineages) {
              const choice = lineage.observations[0]!.observation
              await page.locator(`[data-choice="${choice.choiceKey}"] .choice-verdict`).waitFor()
              for (const text of [choice.scenario, choice.gap, choice.reach])
                await page.getByText(text, { exact: true }).waitFor()
            }
            for (const text of [
              'Change the retention setting before the first scheduled deletion; export any records that must be kept.',
              'One logical payment must keep the same idempotency key across all network retries.',
              'Explicit removal · this choice is no longer present.',
              'Every remaining implementation decision was explicitly requested by the owner or delegated by the spec; no undeclared choice was found.',
            ])
              await page.getByText(text, { exact: true }).waitFor()
            assert.equal(
              await page.locator('[data-choice="presentation.choice-4"] button').count(),
              0,
            )
            assert.deepEqual(
              await page
                .locator('.choice-group')
                .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-verdict'))),
              ['needs-user', 'unsound', 'sound'],
            )
            assert.equal(await page.locator('img,pre.response').count(), 0)
            await page.getByText('Result · partial', { exact: true }).waitFor()
            assert.equal(
              await page
                .locator('#reviews article')
                .filter({ hasText: '0 audited choices' })
                .filter({ hasText: 'Completed workspace audit' })
                .count(),
              1,
            )
            await page.locator('#decisions .choice-evidence').first().locator('summary').click()
            await page.locator('#decisions .evidence-digest').first().waitFor({ state: 'visible' })
            await page.locator('#decisions .choice-evidence').first().locator('summary').click()
          }
          if (fixture.id.startsWith('choices')) {
            await page
              .getByText('Keep receipts for 90 days while the owner chooses a retention policy.', {
                exact: true,
              })
              .waitFor()
            if (fixture.id === 'choices-readonly') {
              await page
                .getByText(
                  'Canonical branch is not configured. These choices are read-only; scope and human status are unavailable.',
                  { exact: true },
                )
                .waitFor()
              assert.equal(await page.locator('#decisions button').count(), 0)
            }
          }
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
          if (!captures.has(fixture.id)) continue
          const file = `${fixture.id}--${viewport.name}.png`
          const path = join(screenshots, file)
          await page.screenshot({ path, animations: 'disabled' })
          files.push(file)
        }
      }
      await context.close()
    } finally {
      await handle.stop()
    }
  }
  for (const file of files) {
    const current = await readFile(join(screenshots, file))
    if (check)
      assert.ok(
        current.equals(await readFile(join(outputRoot, file))),
        `localhost UI screenshot changed: ${file}`,
      )
    else await Bun.write(join(outputRoot, file), current)
  }
  process.stdout.write(
    `${check ? 'Matched' : 'Updated'} ${files.length} screenshots; checked ${fixtures.length} browser scenarios.\n`,
  )
} finally {
  await browser.close()
  await rm(captureRoot, { recursive: true, force: true })
}
