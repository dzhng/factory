import { realpath } from 'node:fs/promises'

import {
  canonicalJson,
  type ResolvedReviewerSettings,
  type ReviewerSettings,
} from '@factory/contract'
import {
  verifyBundle,
  type ReviewAcceptanceAuthority,
  type ReviewAcceptanceProjection,
  type ReviewBundleManifest,
} from '@factory/review-plan'

declare const verifiedReviewBundleBrand: unique symbol
export type VerifiedReviewBundle = { readonly [verifiedReviewBundleBrand]: true }

type VerifiedReviewBundleState = {
  path: string
  sha256: string
  manifest: ReviewBundleManifest
  acceptance: ReviewAcceptanceProjection
  authority: ReviewAcceptanceAuthority
}

const states = new WeakMap<object, VerifiedReviewBundleState>()

function snapshot<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

/** Verify a portable bundle before credential discovery or Docker work begins. */
export async function openVerifiedReviewBundle(
  path: string,
  expectedSha256: string,
): Promise<VerifiedReviewBundle> {
  const canonicalPath = await realpath(path)
  const verification = await verifyBundle(canonicalPath, expectedSha256)
  if (!verification.valid) throw new Error(`review bundle is invalid: ${verification.reason}`)
  if (verification.manifest.plan.status !== 'ready') {
    throw new Error(
      `review plan does not authorize execution: ${verification.manifest.plan.status}`,
    )
  }
  const capability = Object.freeze({}) as VerifiedReviewBundle
  states.set(capability, {
    path: canonicalPath,
    sha256: expectedSha256,
    manifest: snapshot(verification.manifest),
    acceptance: snapshot(verification.acceptance),
    authority: snapshot(verification.authority),
  })
  return capability
}

export async function readVerifiedReviewBundle(
  bundle: VerifiedReviewBundle,
): Promise<Readonly<VerifiedReviewBundleState>> {
  const state = states.get(bundle)
  if (state === undefined) throw new TypeError('review bundle capability is not verified')
  const verification = await verifyBundle(state.path, state.sha256)
  if (!verification.valid) throw new Error(`review bundle changed: ${verification.reason}`)
  if (canonicalJson(verification.manifest) !== canonicalJson(state.manifest)) {
    throw new Error('review bundle changed after verification')
  }
  return snapshot(state)
}

export type ReviewerAvailability = Readonly<Record<'codex' | 'claude', boolean>>
export type ReviewerChoice = {
  settings: ResolvedReviewerSettings
  authoringProvider?: 'codex' | 'claude'
}
export type ReviewerDefaults = Readonly<
  Record<'codex' | 'claude', Omit<ResolvedReviewerSettings, 'provider'>>
>

export type ReviewerChoiceResult =
  | { kind: 'selected'; choice: ReviewerChoice }
  | { kind: 'unavailable'; choice: ReviewerChoice; reason: 'authentication-unavailable' }

const DEFAULT_AUTO_PROVIDER = 'codex' as const

/** Resolve one reviewer. Mixed evidence supplies context but never fans out execution. */
export function selectReviewer(
  configured: 'auto' | ReviewerSettings,
  newestCoveredProvider: 'codex' | 'claude' | undefined,
  authenticated: ReviewerAvailability,
  defaults: ReviewerDefaults,
): ReviewerChoiceResult {
  if (configured !== 'auto') {
    const choice: ReviewerChoice = {
      settings: {
        provider: configured.provider,
        model: configured.model ?? defaults[configured.provider].model,
        effort: configured.effort ?? defaults[configured.provider].effort,
      },
      ...(newestCoveredProvider === undefined ? {} : { authoringProvider: newestCoveredProvider }),
    }
    return authenticated[configured.provider]
      ? { kind: 'selected', choice }
      : { kind: 'unavailable', choice, reason: 'authentication-unavailable' }
  }
  const preferred =
    newestCoveredProvider === undefined
      ? DEFAULT_AUTO_PROVIDER
      : newestCoveredProvider === 'codex'
        ? 'claude'
        : 'codex'
  const fallback = newestCoveredProvider ?? (preferred === 'codex' ? 'claude' : 'codex')
  const provider = authenticated[preferred]
    ? preferred
    : authenticated[fallback]
      ? fallback
      : preferred
  const choice: ReviewerChoice = {
    settings: { provider, ...defaults[provider] },
    ...(newestCoveredProvider === undefined ? {} : { authoringProvider: newestCoveredProvider }),
  }
  return authenticated[provider]
    ? { kind: 'selected', choice }
    : { kind: 'unavailable', choice, reason: 'authentication-unavailable' }
}
