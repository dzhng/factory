import { canonicalJson, type EvidenceTransformation } from '@factory/contract'
import { SanitizationError, type createSanitizer } from '@factory/sanitization'
type Sanitizer = ReturnType<typeof createSanitizer>

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new TypeError(`${label} is not a Git object ID`)
  }
}

function optionalSha(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined
  assertSha(value, label)
  return value
}

/** Evidence permits redacted provider scalars; only validated Git fields retain SHA authority. */
export function prepareGithubMetadata(
  bytes: Uint8Array,
  sanitizer: Sanitizer,
  transformation: EvidenceTransformation,
  graphql: boolean,
): Uint8Array {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  const pr = graphql ? value.data?.repository?.pullRequest : undefined
  if (graphql) {
    const object = (candidate: unknown): Record<string, unknown> => {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
        throw new TypeError('GitHub metadata evidence container is invalid')
      return candidate as Record<string, unknown>
    }
    const repository = object(object(value.data).repository)
    const pullRequest = object(repository.pullRequest)
    for (const key of ['id', 'nameWithOwner', 'url'])
      if (!Object.hasOwn(repository, key))
        throw new TypeError('GitHub repository evidence is incomplete')
    for (const key of ['id', 'url', 'number', 'state', 'updatedAt'])
      if (!Object.hasOwn(pullRequest, key))
        throw new TypeError('GitHub pull request evidence is incomplete')
    const commits = object(pullRequest.commits)
    if (!Array.isArray(commits.nodes)) throw new TypeError('GitHub commit evidence is invalid')
    object(commits.pageInfo)
    for (const key of ['baseRefOid', 'headRefOid']) optionalSha(pullRequest[key], key)
    for (const node of commits.nodes)
      assertSha(object(object(node).commit).oid, 'commit evidence oid')
  }
  const preserved: { index?: number; key: string; value: string }[] = []
  const keep = (parent: Record<string, unknown>, key: string, index?: number) => {
    const value = parent[key]
    if (typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
      preserved.push({ index, key, value })
      parent[key] = null
    }
  }
  if (pr) {
    keep(pr, 'baseRefOid')
    keep(pr, 'headRefOid')
    for (const [index, node] of pr.commits.nodes.entries()) keep(node.commit, 'oid', index)
  }
  // Prepare the whole tree, including unknown fields and keys. Restore only the
  // explicitly validated paths; changed schema keys cannot become new authority.
  let transformed: ReturnType<Sanitizer['json']>
  try {
    transformed = sanitizer.json(value)
  } catch (error) {
    if (!(error instanceof SanitizationError) || error.code !== 'json-key-collision') throw error
    transformation.redacted = true
    transformation.omissionReasons = [
      ...new Set([...transformation.omissionReasons, 'json-key-collision' as const]),
    ]
    return new TextEncoder().encode(canonicalJson({ omitted: 'json-key-collision' }))
  }
  transformation.redacted ||= transformed.redacted
  const safe = transformed.value as typeof value
  if (pr) {
    const safePr = safe.data?.repository?.pullRequest
    if (!safePr || !Array.isArray(safePr.commits?.nodes))
      throw new SanitizationError('unsupported-content')
    for (const { index, key, value: sha } of preserved) {
      const destination = index === undefined ? safePr : safePr.commits.nodes[index]?.commit
      if (!destination || !Object.hasOwn(destination, key))
        throw new SanitizationError('unsupported-content')
      destination[key] = sha
    }
  }
  return new TextEncoder().encode(canonicalJson(safe))
}
