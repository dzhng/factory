import { createHash } from 'node:crypto'

import { parseCodeManifest, type CodeManifest, type ObjectRef } from '../../contract/src/index'
import type { GitObjectStore } from '../src/git-observer'

/** Disposable object buffer for Docker fixtures; production persistence stays in RepositoryStore. */
export class MemoryGitObjectStore implements GitObjectStore {
  private readonly objects = new Map<string, Uint8Array>()

  async put(bytes: Uint8Array, metadata: { mediaType: string; role: string }): Promise<ObjectRef> {
    const digest = createHash('sha256').update(bytes).digest('hex')
    this.objects.set(digest, bytes.slice())
    return {
      algorithm: 'sha256',
      sha256: digest,
      bytes: bytes.byteLength,
      ...metadata,
    }
  }

  async get(ref: ObjectRef): Promise<Uint8Array> {
    const bytes = this.objects.get(ref.sha256)
    if (
      bytes === undefined ||
      bytes.byteLength !== ref.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== ref.sha256
    ) {
      throw new Error(`Git observation object is unavailable or corrupt: ${ref.sha256}`)
    }
    return bytes.slice()
  }

  async readJson(ref: ObjectRef): Promise<CodeManifest> {
    return parseCodeManifest(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.get(ref))),
    )
  }
}
