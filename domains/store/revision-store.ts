export interface RevisionRef {
  readonly artifactId: string
  readonly revisionId: string
}

export type RevisionObjectRef = RevisionRef & (
  | { readonly kind: 'manifest' }
  | { readonly kind: 'resource'; readonly path: string }
)

export interface StoredObjectInfo {
  readonly key: string
  readonly size: number
  readonly sha256: string
  readonly version: string
}

export type StoreErrorCode = 'invalid_input' | 'conflict' | 'integrity_error' | 'unavailable'

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(code)
    this.name = 'StoreError'
  }
}

const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')

function prefix(instanceId: string, ref: RevisionRef): string {
  // These are the opaque ID grammar used by Catalogue's ID generator and routing.
  if (!ref || typeof ref.artifactId !== 'string' || !/^ar_[a-z2-7]{26}$/.test(ref.artifactId) ||
      typeof ref.revisionId !== 'string' || !/^rv_[a-z2-7]{26}$/.test(ref.revisionId)) {
    throw new StoreError('invalid_input')
  }
  return `${instanceId}/${ref.artifactId}/${ref.revisionId}/`
}

async function objectKey(instanceId: string, ref: RevisionObjectRef): Promise<string> {
  const base = prefix(instanceId, ref)
  if (ref.kind === 'manifest') return `${base}manifest.json`
  // TextEncoder replaces unpaired surrogates; rejecting them prevents path collisions.
  if (ref.kind !== 'resource' || typeof ref.path !== 'string' || !ref.path ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(ref.path)) {
    throw new StoreError('invalid_input')
  }
  return `${base}resources/${hex(await crypto.subtle.digest('SHA-256', encoder.encode(ref.path)))}`
}

function info(object: R2Object): StoredObjectInfo {
  const checksum = object.checksums?.sha256
  if (!checksum || checksum.byteLength !== 32) throw new StoreError('integrity_error')
  return { key: object.key, size: object.size, sha256: hex(checksum), version: object.version }
}

function asStoreError(error: unknown): StoreError {
  return error instanceof StoreError ? error : new StoreError('unavailable')
}

export class RevisionStore {
  readonly instanceId: string
  private readonly bucket: R2Bucket

  constructor(bucket: R2Bucket, instanceId: string) {
    if (typeof instanceId !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(instanceId)) throw new StoreError('invalid_input')
    this.bucket = bucket
    this.instanceId = instanceId
  }

  async put(ref: RevisionObjectRef, expected: { readonly size: number; readonly sha256: string }, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<StoredObjectInfo> {
    if (!expected || !Number.isSafeInteger(expected.size) || expected.size < 0 ||
        typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sha256) ||
        !body || typeof body.pipeTo !== 'function' || body.locked) throw new StoreError('invalid_input')
    const key = await objectKey(this.instanceId, ref)
    if (signal?.aborted) throw new StoreError('unavailable')

    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const stream = new FixedLengthStream(expected.size)
    const pipe = body.pipeTo(stream.writable, { signal: controller.signal })
    // A failed producer must interrupt a pending R2 put; successful piping alone
    // must not win the race against the provider's checksum verification.
    const pipeFailure = pipe.then(() => new Promise<never>(() => {}), () => {
      throw new StoreError('unavailable')
    })
    const cancelled = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(new StoreError('unavailable'))
      else controller.signal.addEventListener('abort', () => reject(new StoreError('unavailable')), { once: true })
    })
    try {
      const result = await Promise.race([
        this.bucket.put(key, stream.readable, { onlyIf: new Headers({ 'If-None-Match': '*' }), sha256: expected.sha256 }),
        pipeFailure,
        cancelled,
      ])
      if (result === null) {
        controller.abort()
        const existing = await this.bucket.head(key)
        if (!existing) throw new StoreError('unavailable')
        const stored = info(existing)
        if (stored.size !== expected.size || stored.sha256 !== expected.sha256) throw new StoreError('conflict')
        return stored
      }
      await Promise.race([pipe, cancelled])
      const stored = info(result)
      if (stored.size !== expected.size || stored.sha256 !== expected.sha256) throw new StoreError('integrity_error')
      return stored
    } catch (error) {
      throw asStoreError(error)
    } finally {
      controller.abort()
      signal?.removeEventListener('abort', abort)
    }
  }

  async head(ref: RevisionObjectRef): Promise<StoredObjectInfo | null> {
    try {
      const object = await this.bucket.head(await objectKey(this.instanceId, ref))
      return object ? info(object) : null
    } catch (error) { throw asStoreError(error) }
  }

  async get(ref: RevisionObjectRef, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
    try {
      const object = await this.bucket.get(await objectKey(this.instanceId, ref), options)
      if (object) {
        try { info(object) } catch (error) {
          if ('body' in object && object.body) void object.body.cancel().catch(() => {})
          throw error
        }
      }
      return object
    } catch (error) { throw asStoreError(error) }
  }

  async deleteRevision(ref: RevisionRef): Promise<number> {
    const revisionPrefix = prefix(this.instanceId, ref)
    let cursor: string | undefined
    let count = 0
    try {
      do {
        const page = await this.bucket.list({ prefix: revisionPrefix, limit: 1000, cursor })
        const keys = page.objects.map(object => object.key)
        if (keys.some(key => !key.startsWith(revisionPrefix))) throw new StoreError('integrity_error')
        if (keys.length) {
          await this.bucket.delete(keys)
          count += keys.length
        }
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor !== undefined)
      return count
    } catch (error) { throw asStoreError(error) }
  }
}
