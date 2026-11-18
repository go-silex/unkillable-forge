import { RevisionStore, StoreError, type DerivedObjectRef, type RevisionRef, type StoredObjectInfo } from './revision-store'

export type { DerivedObjectRef } from './revision-store'

export interface DerivedDescriptor {
  readonly ref: DerivedObjectRef
  readonly objectKey: string
  readonly size: number
  readonly sha256: string
  readonly contentType: 'image/jpeg' | 'image/png'
  readonly objectVersion: string
}

/** Immutable derived bytes. Read authority and selection remain Catalogue's responsibility. */
export class DerivedStore {
  constructor(private readonly revisions: RevisionStore) {}

  private descriptor(ref: DerivedObjectRef, info: StoredObjectInfo): DerivedDescriptor {
    if (info.sha256 !== ref.contentSha256 || !info.version) throw new StoreError('integrity_error')
    return { ref, objectKey: info.key, size: info.size, sha256: info.sha256,
      contentType: ref.extension === 'jpg' ? 'image/jpeg' : 'image/png', objectVersion: info.version }
  }

  async put(ref: DerivedObjectRef, expected: { readonly size: number; readonly sha256: string }, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<DerivedDescriptor> {
    return this.descriptor(ref, await this.revisions.put(ref, expected, body, signal))
  }

  async head(ref: DerivedObjectRef): Promise<DerivedDescriptor | null> {
    const info = await this.revisions.head(ref)
    return info === null ? null : this.descriptor(ref, info)
  }
  async listRevision(ref: RevisionRef, cursor: string | null) {
    return this.revisions.listDerivedRevision(ref, cursor)
  }


  async get(ref: DerivedObjectRef, range?: { readonly offset: number; readonly length: number }): Promise<R2ObjectBody | null> {
    if (range && (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length <= 0)) throw new StoreError('invalid_input')
    const object = await this.revisions.get(ref, range ? { range } : undefined)
    if (!object) return null
    if (!('body' in object) || !object.body || !object.checksums.sha256 ||
        Array.from(new Uint8Array(object.checksums.sha256), byte => byte.toString(16).padStart(2, '0')).join('') !== ref.contentSha256 || !object.version) {
      if ('body' in object && object.body) void object.body.cancel().catch(() => {})
      throw new StoreError('integrity_error')
    }
    return object
  }
}
