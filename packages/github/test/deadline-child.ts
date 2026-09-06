import { createHash } from 'node:crypto'

import type { ObjectRef, RepositoryId } from '../../contract/src/index'
import { createSanitizer } from '../../sanitization/src/index'
import {
  GithubPrObserver,
  observeGithubRepositoryMapping,
  type GhCommandResult,
  type PrObjectStore,
} from '../src/index'

const mode = process.argv[2]
const head = '3'.repeat(40)
const metadata = JSON.stringify({
  data: {
    repository: {
      id: 'R_base',
      nameWithOwner: 'owner/repo',
      url: 'https://github.example.com/owner/repo',
      pullRequest: {
        id: 'PR_42',
        url: 'https://github.example.com/owner/repo/pull/42',
        number: 42,
        state: 'OPEN',
        mergedAt: null,
        baseRefName: 'main',
        baseRefOid: '1'.repeat(40),
        headRefName: 'feature',
        headRefOid: head,
        updatedAt: '2026-09-05T00:00:00Z',
        headRepository: {
          id: 'R_base',
          nameWithOwner: 'owner/repo',
          url: 'https://github.example.com/owner/repo',
        },
        commits: {
          nodes: [{ commit: { oid: head } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  },
})
const completed = (stdout: string): GhCommandResult => ({
  kind: 'completed',
  exitCode: 0,
  stdout: Buffer.from(stdout),
  stderr: new Uint8Array(),
})
const memory: PrObjectStore = {
  put: async (bytes, objectMetadata) => ({
    algorithm: 'sha256',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    ...objectMetadata,
  }),
}
const hanging: PrObjectStore = {
  put: async () => new Promise<ObjectRef>(() => {}),
}

if (mode === 'mapping-store') {
  const result = await observeGithubRepositoryMapping(
    'repo_fixture' as RepositoryId,
    'github.example.com',
    {
      sanitizer: createSanitizer([]),
      run: async () =>
        completed(
          JSON.stringify({
            id: 'R_base',
            nameWithOwner: 'owner/repo',
            url: 'https://github.example.com/owner/repo',
          }),
        ),
      objects: hanging,
      maxAcquisitionDurationMs: 20,
      now: () => new Date('2026-09-05T01:00:00Z'),
    },
  )
  console.log(JSON.stringify(result))
} else {
  const result = await new GithubPrObserver({
    sanitizer: createSanitizer([]),
    run: async args => completed(args[0] === 'pr' ? 'diff' : metadata),
    objects: mode === 'pr-store' ? hanging : memory,
    maxAcquisitionDurationMs: mode === 'capture' ? 1_000 : 20,
    ...(mode === 'capture' ? { maxCodeCaptureDurationMs: 20 } : {}),
    ...(mode === 'capture'
      ? { captureCodeManifest: async () => new Promise<ObjectRef>(() => {}) }
      : {}),
    now: () => new Date('2026-09-05T01:00:00Z'),
  }).observe({ hostname: 'github.example.com', owner: 'owner', name: 'repo', number: 42 })
  console.log(JSON.stringify(result))
}
