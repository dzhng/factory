import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, normalize, posix, sep } from 'node:path'

export type ReviewerProvider = 'codex' | 'claude'
export type IsolationProvider = ReviewerProvider | 'fake'

export type ReadonlyAuthMount<Provider extends IsolationProvider = ReviewerProvider> = {
  hostPath: string
  containerPath: `/auth/${Provider}/${string}`
  mode: 'ro'
  expectedIdentity?: AuthFileIdentity
}

export type AuthFileIdentity = {
  dev: number
  ino: number
  size: number
  uid: number
  mode: number
}

export type IsolationInput<Provider extends IsolationProvider = ReviewerProvider> = {
  provider: Provider
  bundleHostPath: string
  outputHostPath: string
  auth: readonly Omit<ReadonlyAuthMount<Provider>, 'mode'>[]
}

export type MountPlan<Provider extends IsolationProvider = ReviewerProvider> = {
  provider: Provider
  bundle: {
    hostPath: string
    containerPath: '/bundle'
    mode: 'ro'
  }
  output: {
    hostPath: string
    containerPath: '/out'
    mode: 'rw'
  }
  auth: readonly ReadonlyAuthMount<Provider>[]
}

export type IsolationRefusal = {
  ok: false
  reason:
    | 'host-path-not-absolute'
    | 'host-root-forbidden'
    | 'host-path-unsupported'
    | 'host-path-overlap'
    | 'auth-target-outside-provider-scope'
    | 'auth-target-duplicate'
  detail: string
}

export type IsolationPlanResult<Provider extends IsolationProvider = ReviewerProvider> =
  | { ok: true; plan: MountPlan<Provider> }
  | IsolationRefusal

function containsPath(parent: string, child: string): boolean {
  const normalizedParent = normalize(parent)
  const normalizedChild = normalize(child)
  return (
    normalizedParent === normalizedChild || normalizedChild.startsWith(`${normalizedParent}${sep}`)
  )
}

export function planIsolation<Provider extends IsolationProvider>(
  input: IsolationInput<Provider>,
): IsolationPlanResult<Provider> {
  const mounts = [
    { role: 'bundle', hostPath: input.bundleHostPath },
    { role: 'output', hostPath: input.outputHostPath },
    ...input.auth.map(({ hostPath }) => ({ role: 'auth', hostPath })),
  ]

  for (const mount of mounts) {
    if (!isAbsolute(mount.hostPath)) {
      return {
        ok: false,
        reason: 'host-path-not-absolute',
        detail: `${mount.role} mount must use an absolute host path`,
      }
    }
    if (normalize(mount.hostPath) === sep) {
      return {
        ok: false,
        reason: 'host-root-forbidden',
        detail: `${mount.role} mount may not expose the host root`,
      }
    }
    if (mount.hostPath.includes(',')) {
      return {
        ok: false,
        reason: 'host-path-unsupported',
        detail: `${mount.role} mount path contains a comma that Docker --mount cannot represent safely`,
      }
    }
  }

  for (let left = 0; left < mounts.length; left += 1) {
    for (let right = left + 1; right < mounts.length; right += 1) {
      const leftMount = mounts[left]
      const rightMount = mounts[right]
      if (
        leftMount !== undefined &&
        rightMount !== undefined &&
        (containsPath(leftMount.hostPath, rightMount.hostPath) ||
          containsPath(rightMount.hostPath, leftMount.hostPath))
      ) {
        return {
          ok: false,
          reason: 'host-path-overlap',
          detail: `${leftMount.role} and ${rightMount.role} mounts must not overlap`,
        }
      }
    }
  }

  const providerAuthRoot = `/auth/${input.provider}/`
  const seenTargets = new Set<string>()
  for (const auth of input.auth) {
    const normalizedTarget = posix.normalize(auth.containerPath)
    if (normalizedTarget !== auth.containerPath || !normalizedTarget.startsWith(providerAuthRoot)) {
      return {
        ok: false,
        reason: 'auth-target-outside-provider-scope',
        detail: `auth target must be below ${providerAuthRoot}`,
      }
    }
    if (seenTargets.has(auth.containerPath)) {
      return {
        ok: false,
        reason: 'auth-target-duplicate',
        detail: `auth target ${auth.containerPath} is duplicated`,
      }
    }
    seenTargets.add(auth.containerPath)
  }

  return {
    ok: true,
    plan: {
      provider: input.provider,
      bundle: { hostPath: input.bundleHostPath, containerPath: '/bundle', mode: 'ro' },
      output: { hostPath: input.outputHostPath, containerPath: '/out', mode: 'rw' },
      auth: input.auth.map(auth => ({ ...auth, mode: 'ro' })),
    },
  }
}

export function planReviewerIsolation(input: IsolationInput): IsolationPlanResult {
  return planIsolation(input)
}

/** Resolve host filesystem identities before applying the mount policy. */
export async function resolveIsolation<Provider extends IsolationProvider>(
  input: IsolationInput<Provider>,
): Promise<IsolationPlanResult<Provider>> {
  const authBefore = await Promise.all(input.auth.map(({ hostPath }) => lstat(hostPath)))
  const [bundleHostPath, outputHostPath, ...authHostPaths] = await Promise.all([
    realpath(input.bundleHostPath),
    realpath(input.outputHostPath),
    ...input.auth.map(({ hostPath }) => realpath(hostPath)),
  ])
  const authAfter = await Promise.all(authHostPaths.map(path => lstat(path)))
  for (const [index, before] of authBefore.entries()) {
    const after = authAfter[index]
    const expected = input.auth[index]?.expectedIdentity
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      after === undefined ||
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (expected !== undefined &&
        (after.dev !== expected.dev ||
          after.ino !== expected.ino ||
          after.size !== expected.size ||
          after.uid !== expected.uid ||
          after.mode !== expected.mode))
    )
      throw new Error('Reviewer authentication path changed during canonicalization')
  }

  return planIsolation({
    ...input,
    bundleHostPath,
    outputHostPath,
    auth: input.auth.map((auth, index) => ({
      ...auth,
      hostPath: authHostPaths[index] ?? auth.hostPath,
      expectedIdentity:
        auth.expectedIdentity ??
        (authAfter[index] === undefined
          ? undefined
          : {
              dev: authAfter[index].dev,
              ino: authAfter[index].ino,
              size: authAfter[index].size,
              uid: authAfter[index].uid,
              mode: authAfter[index].mode,
            }),
    })),
  })
}

export async function resolveReviewerIsolation(
  input: IsolationInput,
): Promise<IsolationPlanResult> {
  return await resolveIsolation(input)
}
