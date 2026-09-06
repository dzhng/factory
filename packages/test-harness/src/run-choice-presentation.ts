import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { presentDecisions } from '@factory/domain'
import { serveLocalUi } from '@factory/web'
import { chromium } from 'playwright-core'

import { choicePresentationFixture, presentationDecisions } from './choice-presentation-fixtures'

const output = resolve(process.argv[2] ?? '/tmp/choice-presentation')
await mkdir(output, { recursive: true })
let snapshot = choicePresentationFixture()
const server = await serveLocalUi({
  host: '127.0.0.1',
  snapshot: async () => snapshot,
  actions: { appendDecision: async () => {}, acceptCoverage: async () => {} },
})
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'UTC',
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(2000)
  for (const viewport of [
    { name: 'wide', width: 1440, height: 1000 },
    { name: 'narrow', width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto(server.origin)
    await page.locator('#app[data-ready]').waitFor()
    if (process.argv.includes('--assert')) {
      await page
        .getByText('Keep receipts for 90 days while the owner chooses a retention policy.', {
          exact: true,
        })
        .waitFor({ timeout: 2000 })
      await page
        .getByText(
          'Change the retention setting before the first scheduled deletion; export any records that must be kept.',
          { exact: true },
        )
        .waitFor({ timeout: 2000 })
      for (const lineage of presentationDecisions().lineages) {
        const choice = lineage.observations[0]!.observation
        await page.locator(`[data-choice="${choice.choiceKey}"] .choice-verdict`).waitFor()
        await page.getByText(choice.scenario, { exact: true }).waitFor({ timeout: 2000 })
        await page.getByText(choice.gap, { exact: true }).waitFor({ timeout: 2000 })
        await page.getByText(choice.reach, { exact: true }).waitFor({ timeout: 2000 })
      }
      await page
        .getByText(
          'One logical payment must keep the same idempotency key across all network retries.',
          { exact: true },
        )
        .waitFor()
      await page
        .getByText('Explicit removal · this choice is no longer present.', { exact: true })
        .waitFor()
      if (await page.locator('[data-choice="presentation.choice-4"] button').count())
        throw Error('removed choice has mutation controls')
      if (
        (
          await page
            .locator('.choice-group')
            .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-verdict')))
        ).join(',') !== 'needs-user,unsound,sound'
      )
        throw Error('verdict order')
      await page
        .getByText(
          'Every remaining implementation decision was explicitly requested by the owner or delegated by the spec; no undeclared choice was found.',
          { exact: true },
        )
        .waitFor()
      if (await page.locator('img,pre.response').count())
        throw Error('raw diagnostics or markup escaped into UI')
      await page.getByText('Result · partial', { exact: true }).waitFor()
      const empty = page
        .locator('#reviews article')
        .filter({ hasText: '0 audited choices' })
        .filter({ hasText: 'Completed workspace audit' })
      if ((await empty.count()) !== 1) throw Error('empty completed audit missing')
    }
    await page.locator('#decisions').scrollIntoViewIfNeeded()
    await page.evaluate("document.querySelector('#decisions').scrollIntoView({block:'start'})")
    if (
      await page.evaluate(
        'document.documentElement.scrollWidth>document.documentElement.clientWidth',
      )
    )
      throw Error('horizontal overflow')
    await page.screenshot({
      path: resolve(output, `ledger--${viewport.name}.png`),
      animations: 'disabled',
    })
    await page.locator('#decisions').screenshot({
      path: resolve(output, `ledger-full--${viewport.name}.png`),
      animations: 'disabled',
    })
    if (process.argv.includes('--assert')) {
      await page.locator('#decisions .choice-evidence').first().locator('summary').click()
      await page.locator('#decisions .evidence-digest').first().waitFor({ state: 'visible' })
      await page
        .locator('#decisions .choice-evidence')
        .first()
        .screenshot({ path: resolve(output, `provenance--${viewport.name}.png`) })
      await page.locator('#reviews').screenshot({
        path: resolve(output, `audits--${viewport.name}.png`),
        animations: 'disabled',
      })
      for (const index of [2, 3, 4])
        await page.locator(`[data-choice="presentation.choice-${index}"]`).screenshot({
          path: resolve(output, `choice-${index}--${viewport.name}.png`),
          animations: 'disabled',
        })
    }
  }
  if (process.argv.includes('--assert')) {
    snapshot = {
      ...snapshot,
      canonicalBranch: null,
      decisions: presentDecisions({
        unclassified: presentationDecisions().lineages.flatMap(lineage =>
          lineage.observations.map(item => item.observation),
        ),
      }),
    }
    for (const viewport of [
      { name: 'wide', width: 1440, height: 1000 },
      { name: 'narrow', width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport)
      await page.goto(server.origin)
      await page.locator('#app[data-ready]').waitFor()
      await page
        .getByText(
          'Canonical branch is not configured. These choices are read-only; scope and human status are unavailable.',
          { exact: true },
        )
        .waitFor()
      if (await page.locator('#decisions button').count())
        throw Error('unclassified choices gained action authority')
      if (
        await page.evaluate(
          'document.documentElement.scrollWidth>document.documentElement.clientWidth',
        )
      )
        throw Error('read-only horizontal overflow')
      await page
        .getByText('Keep receipts for 90 days while the owner chooses a retention policy.', {
          exact: true,
        })
        .waitFor()
      await page.evaluate("document.querySelector('#decisions').scrollIntoView({block:'start'})")
      await page.screenshot({
        path: resolve(output, `read-only--${viewport.name}.png`),
        animations: 'disabled',
      })
    }
  }
} finally {
  await browser.close()
  await server.stop()
}
