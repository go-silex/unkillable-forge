export interface RevisionRef {
  readonly artifactId: string
  readonly revisionId: string
}

export interface DerivedObjectRef extends RevisionRef {
  readonly kind: 'og'
  readonly pageId: string
  readonly recipeSha256: string
  readonly inputSha256: string
  readonly contentSha256: string
  readonly extension: 'jpg' | 'png'
}

export type RevisionObjectRef = (RevisionRef & (
  | { readonly kind: 'manifest' }
  | { readonly kind: 'resource'; readonly path: string }
)) | DerivedObjectRef

export interface StoredObjectInfo {
  readonly key: string
  readonly size: number
  readonly sha256: string
  readonly version: string
}

export interface ListedRevisionObject {
  readonly key: string
  readonly size: number
  readonly version: string
  readonly sha256: string | null
}

export type StoreErrorCode = 'invalid_input' | 'conflict' | 'integrity_error' | 'unavailable'

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'StoreError'
  }
}

/** The input stream failed its declared length or digest, not a provider write. */
export class SourceIntegrityError extends StoreError {
  constructor() {
    super('integrity_error')
    this.name = 'SourceIntegrityError'
  }
}

// Workers extends Web Crypto with a streaming digest; DOM's Crypto type does not.
type WorkersCrypto = Crypto & {
  readonly DigestStream: new (algorithm: string) => WritableStream<ArrayBuffer | ArrayBufferView> & { readonly digest: Promise<ArrayBuffer> }
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

export function derivedObjectKey(instanceId: string, ref: DerivedObjectRef): string {
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(instanceId)) throw new StoreError('invalid_input')
  prefix(instanceId, ref)
  if (!/^pg_[a-z2-7]{26}$/.test(ref.pageId) ||
      !/^[a-f0-9]{64}$/.test(ref.recipeSha256) ||
      !/^[a-f0-9]{64}$/.test(ref.inputSha256) ||
      !/^[a-f0-9]{64}$/.test(ref.contentSha256) ||
      (ref.extension !== 'jpg' && ref.extension !== 'png')) throw new StoreError('invalid_input')
  return `${instanceId}/derived/v1/${ref.artifactId}/${ref.revisionId}/${ref.pageId}/og/${ref.recipeSha256}/${ref.inputSha256}/${ref.contentSha256}.${ref.extension}`
}

async function objectKey(instanceId: string, ref: RevisionObjectRef): Promise<string> {
  if (ref.kind === 'og') return derivedObjectKey(instanceId, ref)
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
type ExpectedBytes = { readonly size: number; readonly sha256: string }

function validateBytes(expected: ExpectedBytes, body: ReadableStream<Uint8Array>): void {
  if (!expected || !Number.isSafeInteger(expected.size) || expected.size < 0 ||
      typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      !body || typeof body.pipeTo !== 'function' || body.locked) throw new StoreError('invalid_input')
}

// The optional sink receives everything except the final byte until EOF and
// digest validation succeed, so a fixed-length provider cannot commit early.
export async function verifyRevisionBytes(expected: ExpectedBytes, body: ReadableStream<Uint8Array>, signal?: AbortSignal, sink?: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  validateBytes(expected, body)
  const reader = body.getReader()
  const digest = new (crypto as WorkersCrypto).DigestStream('SHA-256')
  const digestResult = digest.digest
  void digestResult.catch(() => {})
  const writer = digest.getWriter()
  let completed = false
  let abort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new StoreError('unavailable', { cause: signal?.reason }))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
  try {
    const verify = async () => {
      let size = 0, last = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!(chunk.value instanceof Uint8Array)) throw new StoreError('unavailable')
        if (chunk.value.byteLength > expected.size - size) throw new SourceIntegrityError()
        await writer.write(chunk.value)
        const writable = Math.max(0, Math.min(chunk.value.byteLength, expected.size - 1 - size))
        if (sink && writable) await sink.write(chunk.value.subarray(0, writable))
        const lastIndex = expected.size - 1 - size
        if (lastIndex >= 0 && lastIndex < chunk.value.byteLength) last = chunk.value[lastIndex]
        size += chunk.value.byteLength
      }
      await writer.close()
      if (size !== expected.size || hex(await digestResult) !== expected.sha256) throw new SourceIntegrityError()
      if (sink && expected.size) await sink.write(new Uint8Array([last]))
    }
    await Promise.race([verify(), cancelled])
    completed = true
  } catch (error) {
    throw asStoreError(error)
  } finally {
    if (abort) signal?.removeEventListener('abort', abort)
    if (!completed) {
      void reader.cancel().catch(() => {})
      void writer.abort().catch(() => {})
    }
  }
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
    validateBytes(expected, body)
    if (ref?.kind === 'og' && expected.sha256 !== ref.contentSha256) throw new StoreError('invalid_input')
    let abort: (() => void) | undefined
    const verificationAbort = new AbortController()
    let output: WritableStreamDefaultWriter<Uint8Array> | undefined
    let completed = false
    const reconcile = (object: R2Object): StoredObjectInfo => {
      const stored = info(object)
      if (stored.size !== expected.size || stored.sha256 !== expected.sha256) throw new StoreError('conflict')
      return stored
    }
    try {
      const key = await objectKey(this.instanceId, ref)
      if (signal?.aborted) throw new StoreError('unavailable', { cause: signal.reason })
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => { verificationAbort.abort(signal?.reason); reject(new StoreError('unavailable', { cause: signal?.reason })) }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
      // A verified existing object makes the producer unnecessary. Conditional
      // R2 PUT alone does not promise to reject before consuming its body.
      const existing = await Promise.race([this.bucket.head(key), cancelled])
      if (existing) {
        return reconcile(existing)
      }
      const stream = new FixedLengthStream(expected.size)
      output = stream.writable.getWriter()
      const destination = output
      const pump = async () => {
        await verifyRevisionBytes(expected, body, verificationAbort.signal, destination)
        await destination.close()
      }
      const put = () => this.bucket.put(key, stream.readable, {
        onlyIf: new Headers({ 'If-None-Match': '*' }), sha256: expected.sha256,
      })
      let result: R2Object | null
      if (expected.size === 0) {
        // For zero bytes, close the fixed-length writer after validating input;
        // start R2 first so the close is not blocked on an absent reader.
        await Promise.race([verifyRevisionBytes(expected, body, verificationAbort.signal), cancelled])
        const provider = put()
        const close = destination.close()
        ;[result] = await Promise.race([Promise.all([provider, close]), cancelled])
      } else {
        const provider = put()
        const piping = pump()
        const first = await Promise.race([
          provider.then(value => ({ kind: 'provider' as const, value })),
          piping.then(() => ({ kind: 'piping' as const })),
          cancelled,
        ])
        if (first.kind === 'provider' && first.value === null) result = null
        else {
          const values = await Promise.race([Promise.all([provider, piping]), cancelled])
          result = values[0]
        }
      }
      if (result === null) {
        const existing = await Promise.race([this.bucket.head(key), cancelled])
        if (!existing) throw new StoreError('unavailable')
        return reconcile(existing)
      }
      const stored = info(result)
      if (stored.size !== expected.size || stored.sha256 !== expected.sha256) throw new StoreError('integrity_error')
      completed = true
      return stored
    } catch (error) {
      throw asStoreError(error)
    } finally {
      if (abort) signal?.removeEventListener('abort', abort)
      if (!completed) {
        verificationAbort.abort()
        if (!body.locked) void body.cancel().catch(() => {})
        if (output) void output.abort().catch(() => {})
      }
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

  async listRevision(ref: RevisionRef, cursor: string | null): Promise<{ readonly objects: readonly ListedRevisionObject[]; readonly cursor: string | null }> {
    return this.listPrefix(prefix(this.instanceId, ref), cursor)
  }

  async listDerivedRevision(ref: RevisionRef, cursor: string | null): Promise<{ readonly objects: readonly ListedRevisionObject[]; readonly cursor: string | null }> {
    prefix(this.instanceId, ref)
    return this.listPrefix(`${this.instanceId}/derived/v1/${ref.artifactId}/${ref.revisionId}/`, cursor)
  }

  private async listPrefix(revisionPrefix: string, cursor: string | null): Promise<{ readonly objects: readonly ListedRevisionObject[]; readonly cursor: string | null }> {
    if (cursor !== null && (typeof cursor !== 'string' || !cursor)) throw new StoreError('invalid_input')
    try {
      const page = await this.bucket.list({ prefix: revisionPrefix, limit: 1000, ...(cursor === null ? {} : { cursor }) })
      if (typeof page.truncated !== 'boolean' || !Array.isArray(page.objects) ||
          (page.truncated && (typeof page.cursor !== 'string' || !page.cursor || page.cursor === cursor))) {
        throw new StoreError('integrity_error')
      }
      const objects = page.objects.map(object => {
        if (!object || typeof object.key !== 'string' || !object.key.startsWith(revisionPrefix) ||
            typeof object.version !== 'string' || !object.version ||
            !Number.isSafeInteger(object.size) || object.size < 0) throw new StoreError('integrity_error')
        const checksum = object.checksums?.sha256
        if (checksum !== undefined && (!(checksum instanceof ArrayBuffer) || checksum.byteLength !== 32)) {
          throw new StoreError('integrity_error')
        }
        return { key: object.key, size: object.size, version: object.version, sha256: checksum === undefined ? null : hex(checksum) }
      })
      return { objects, cursor: page.truncated ? page.cursor : null }
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
