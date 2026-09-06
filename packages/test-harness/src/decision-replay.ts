import { mkdir, writeFile } from 'node:fs/promises'

import {
  decisionAssertionFingerprint,
  newRecordId,
  type DecisionAction,
  type DecisionObservation,
  type JsonValue,
  type RecordId,
} from '@factory/contract'
import { foldDecisions, type DecisionObservationView, type DecisionView } from '@factory/domain'

import { writerChoice } from './choice-fixtures'

const canonicalBranch = 'main'
const baseTime = Date.parse('2026-09-05T00:00:00.000Z')

function id(prefix: string, sequence: number): RecordId {
  return newRecordId(prefix, baseTime + sequence * 1_000, new Uint8Array(10).fill(sequence))
}

function timestamp(sequence: number): string {
  return new Date(baseTime + sequence * 1_000).toISOString()
}

function observation(input: {
  sequence: number
  choiceKey: string
  effect?: DecisionObservation['effect']
  assertion: JsonValue
  summary: string
  branch: string
}): DecisionObservation {
  const effect = input.effect ?? 'assert'
  return {
    ...writerChoice,
    schemaVersion: 1,
    observationId: id('decision-observation', input.sequence),
    reviewId: id('review', input.sequence),
    reviewEntryId: id('review-entry', input.sequence),
    choiceKey: input.choiceKey,
    effect,
    assertion: input.assertion,
    assertionFingerprint: decisionAssertionFingerprint({ effect, assertion: input.assertion }),
    headline: input.summary,
    source: { kind: 'workspace', branch: input.branch, exactSnapshot: true },
    confidence: 'high',
    observedAt: timestamp(input.sequence),
  }
}

const featureProposal = observation({
  sequence: 1,
  choiceKey: 'storage.review-retention',
  assertion: { retain: '30-days' },
  summary: 'Retain review results for 30 days.',
  branch: 'feature/retention',
})
const firstCanonical = observation({
  sequence: 2,
  choiceKey: 'storage.review-retention',
  assertion: { retain: 'forever' },
  summary: 'Retain review results without expiry.',
  branch: canonicalBranch,
})
const unchangedReplay = observation({
  sequence: 3,
  choiceKey: 'storage.review-retention',
  assertion: { retain: 'forever' },
  summary: 'Keep every review result.',
  branch: canonicalBranch,
})
const changedCanonical = observation({
  sequence: 4,
  choiceKey: 'storage.review-retention',
  assertion: { retain: '365-days' },
  summary: 'Retain review results for one year.',
  branch: canonicalBranch,
})
const removedCanonical = observation({
  sequence: 5,
  choiceKey: 'storage.review-retention',
  effect: 'remove',
  assertion: null,
  summary: 'Remove the review-retention policy.',
  branch: canonicalBranch,
})
const contradictedCanonical = observation({
  sequence: 6,
  choiceKey: 'storage.review-retention',
  effect: 'contradict',
  assertion: { retain: 'session-only' },
  summary: 'A newer constraint requires session-only retention.',
  branch: canonicalBranch,
})

export type DecisionReplayFocus = {
  observationId: RecordId
  summary: string
  lifecycle: DecisionObservationView['lifecycle']
  humanStatus: DecisionObservationView['humanStatus']
  priority: DecisionObservationView['priority']
  pendingReason?: DecisionObservationView['pendingReason']
}

export type DecisionReplayStep = {
  name: string
  explanation: string
  focus: DecisionReplayFocus
  stateFingerprint: string
  lineages: DecisionView['lineages']
  diagnostics: DecisionView['diagnostics']
}

export type DecisionReplayReport = {
  schemaVersion: 1
  canonicalBranch: string
  steps: readonly DecisionReplayStep[]
  determinism: { shuffledInputsMatch: boolean }
}

function findObservation(view: DecisionView, observationId: RecordId): DecisionObservationView {
  for (const lineage of view.lineages) {
    const item = lineage.observations.find(
      entry => entry.observation.observationId === observationId,
    )
    if (item !== undefined) return item
  }
  throw new Error(`decision replay fixture lost ${observationId}`)
}

function replayStep(
  name: string,
  explanation: string,
  observations: readonly DecisionObservation[],
  actions: readonly DecisionAction[],
  focusId: RecordId,
): DecisionReplayStep {
  const view = foldDecisions(observations, actions, canonicalBranch)
  const focus = findObservation(view, focusId)
  return {
    name,
    explanation,
    focus: {
      observationId: focus.observation.observationId,
      summary: focus.observation.headline,
      lifecycle: focus.lifecycle,
      humanStatus: focus.humanStatus,
      priority: focus.priority,
      ...(focus.pendingReason === undefined ? {} : { pendingReason: focus.pendingReason }),
    },
    stateFingerprint: view.stateFingerprint,
    lineages: view.lineages,
    diagnostics: view.diagnostics,
  }
}

export function buildDecisionReplay(): DecisionReplayReport {
  const observations: DecisionObservation[] = []
  const actions: DecisionAction[] = []
  const steps: DecisionReplayStep[] = []
  const addObservation = (item: DecisionObservation, name: string, explanation: string): void => {
    observations.push(item)
    steps.push(replayStep(name, explanation, observations, actions, item.observationId))
  }
  const addAction = (
    action: DecisionAction,
    name: string,
    explanation: string,
    focusId: RecordId,
  ): void => {
    actions.push(action)
    steps.push(replayStep(name, explanation, observations, actions, focusId))
  }
  const stateFingerprint = () =>
    foldDecisions(observations, actions, canonicalBranch).stateFingerprint
  const previousActionId = () =>
    foldDecisions(observations, actions, canonicalBranch).actionHeadId ?? null

  addObservation(
    featureProposal,
    'feature proposal',
    'An exact feature-branch snapshot is evidence, but it is not the configured canonical branch, so it remains a proposal.',
  )
  addObservation(
    firstCanonical,
    'first canonical observation',
    'The first assertion on an exact main snapshot becomes canonical immediately; canonical status does not imply human confirmation.',
  )
  addObservation(
    unchangedReplay,
    'unchanged canonical replay',
    'Different summary prose has the same exact semantic fingerprint, so this is an unchanged canonical replay.',
  )
  addObservation(
    changedCanonical,
    'canonical change',
    'The explicit decision key matches the current lineage but the exact semantic fingerprint changed, so confirmation is predictably high priority.',
  )
  addObservation(
    removedCanonical,
    'canonical removal',
    'An explicit removal never erases the current observation; it creates a high-priority pending supersession.',
  )
  addObservation(
    contradictedCanonical,
    'canonical contradiction',
    'An explicit contradiction is retained beside the current decision as a high-priority pending supersession.',
  )

  addAction(
    {
      schemaVersion: 1,
      actionId: id('decision-action', 7),
      previousActionId: previousActionId(),
      kind: 'confirm',
      targetObservationId: firstCanonical.observationId,
      actor: { kind: 'human', label: 'maintainer' },
      expectedStateFingerprint: stateFingerprint(),
      createdAt: timestamp(7),
    },
    'human confirmation',
    'Human confirmation is an append-only status layered onto canonical evidence; it did not make the observation canonical.',
    firstCanonical.observationId,
  )
  addAction(
    {
      schemaVersion: 1,
      actionId: id('decision-action', 8),
      previousActionId: previousActionId(),
      kind: 'reject',
      targetObservationId: featureProposal.observationId,
      actor: { kind: 'human', label: 'maintainer' },
      expectedStateFingerprint: stateFingerprint(),
      createdAt: timestamp(8),
      note: 'The canonical policy retains evidence longer.',
    },
    'proposal rejection',
    'Rejecting the feature proposal makes only that immutable observation terminal; canonical history is unchanged.',
    featureProposal.observationId,
  )
  const disputeAction: DecisionAction = {
    schemaVersion: 1,
    actionId: id('decision-action', 9),
    previousActionId: previousActionId(),
    kind: 'dispute',
    targetObservationId: firstCanonical.observationId,
    actor: { kind: 'human', label: 'maintainer' },
    expectedStateFingerprint: stateFingerprint(),
    createdAt: timestamp(9),
    note: 'Legal retention requirements need review.',
  }
  addAction(
    disputeAction,
    'human dispute',
    'A dispute raises the current canonical observation to high priority without rewriting its assertion or prior confirmation.',
    firstCanonical.observationId,
  )
  addAction(
    {
      schemaVersion: 1,
      actionId: id('decision-action', 10),
      previousActionId: previousActionId(),
      kind: 'resolve',
      disputeActionId: disputeAction.actionId,
      actor: { kind: 'human', label: 'maintainer' },
      expectedStateFingerprint: stateFingerprint(),
      createdAt: timestamp(10),
      note: 'Legal review confirmed indefinite retention.',
    },
    'dispute resolution',
    'Resolving the active dispute restores the prior confirmed status while preserving both append-only actions.',
    firstCanonical.observationId,
  )
  addAction(
    {
      schemaVersion: 1,
      actionId: id('decision-action', 11),
      previousActionId: previousActionId(),
      kind: 'supersede',
      fromObservationId: firstCanonical.observationId,
      toObservationId: changedCanonical.observationId,
      actor: { kind: 'human', label: 'maintainer' },
      expectedStateFingerprint: stateFingerprint(),
      createdAt: timestamp(11),
      note: 'Adopt the explicit one-year policy.',
    },
    'explicit supersession',
    'The accepted transition marks the prior observation superseded and makes the selected pending assertion current; competing pending evidence remains visible.',
    changedCanonical.observationId,
  )

  const final = foldDecisions(observations, actions, canonicalBranch)
  const shuffled = foldDecisions(
    [...observations].reverse(),
    [...actions].reverse(),
    canonicalBranch,
  )
  return {
    schemaVersion: 1,
    canonicalBranch,
    steps,
    determinism: { shuffledInputsMatch: JSON.stringify(shuffled) === JSON.stringify(final) },
  }
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function reportHtml(report: DecisionReplayReport): string {
  const steps = report.steps
    .map(
      (step, index) => `<article>
        <p class="step">Step ${index + 1}</p>
        <h2>${escapeHtml(step.name)}</h2>
        <p>${escapeHtml(step.explanation)}</p>
        <dl>
          <div><dt>Lifecycle</dt><dd>${escapeHtml(step.focus.lifecycle)}</dd></div>
          <div><dt>Human status</dt><dd>${escapeHtml(step.focus.humanStatus)}</dd></div>
          <div><dt>Priority</dt><dd>${escapeHtml(step.focus.priority)}</dd></div>
          ${step.focus.pendingReason === undefined ? '' : `<div><dt>Pending reason</dt><dd>${escapeHtml(step.focus.pendingReason)}</dd></div>`}
        </dl>
        <p class="summary">${escapeHtml(step.focus.summary)}</p>
      </article>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Canonical decision replay</title>
  <style>
    :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; background: #f4f1e8; color: #201f1b; }
    body { max-width: 1120px; margin: 0 auto; padding: 42px 24px 80px; }
    header { border-bottom: 3px solid #201f1b; margin-bottom: 28px; }
    h1 { font: 700 clamp(2.2rem, 5vw, 4.2rem)/1 Georgia, serif; margin: 0 0 16px; }
    main { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 18px; }
    article { background: #fffdf7; border: 1px solid #201f1b; padding: 20px; box-shadow: 3px 3px 0 #201f1b; }
    h2 { margin: 0; font-size: 1.35rem; }
    .step { margin: 0 0 4px; color: #5a574f; font: 700 .78rem ui-monospace, monospace; text-transform: uppercase; }
    dl div { display: flex; justify-content: space-between; gap: 16px; border-top: 1px solid #cbc6ba; padding: 6px 0; }
    dd { margin: 0; font-weight: 700; }
    .summary { color: #48463f; font-style: italic; }
    .status { display: inline-block; padding: 5px 9px; background: #f4c95d; border: 1px solid #201f1b; }
    footer { margin-top: 28px; color: #5a574f; }
  </style>
</head>
<body>
  <header><p class="status">Slice 10 · deterministic fold</p><h1>Canonical decision replay</h1><p>Canonical scope comes only from an exact <strong>${escapeHtml(report.canonicalBranch)}</strong> snapshot. Human actions remain separate, append-only evidence.</p></header>
  <main>${steps}</main>
  <footer>Shuffled observation and action inputs reproduce the exact final view: <strong>${report.determinism.shuffledInputsMatch}</strong>. Machine-readable detail: <a href="report.json">report.json</a>.</footer>
</body>
</html>\n`
}

export async function writeDecisionReplay(outputDirectory: string): Promise<DecisionReplayReport> {
  const report = buildDecisionReplay()
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all([
    writeFile(`${outputDirectory}/report.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(`${outputDirectory}/index.html`, reportHtml(report), 'utf8'),
  ])
  return report
}
