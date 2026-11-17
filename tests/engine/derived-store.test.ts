import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { newId } from '../../domains/catalogue/ids'
import { DerivedStore, type DerivedObjectRef } from '../../domains/store/derived-store'
import { RevisionStore } from '../../domains/store/revision-store'

const body = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } })
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
}

describe('derived objects on native R2', () => {
  it('preserves originals, binds digest and supports immutable retry and ranged reads', async () => {
    const revisions = new RevisionStore(env.REVISION_BYTES, 'derived-test')
    const store = new DerivedStore(revisions)
    const revision = { artifactId: newId('ar'), revisionId: newId('rv') }
    const original = { ...revision, kind: 'resource' as const, path: '/og.png' }
    const source = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    const sourceHash = await digest(source)
    const originalInfo = await revisions.put(original, { size: source.length, sha256: sourceHash }, body(source))
    const image = new Uint8Array([255, 216, 3, 4, 5, 255, 217])
    const hash = await digest(image)
    const ref: DerivedObjectRef = { ...revision, kind: 'og', pageId: newId('pg'), recipeSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64), contentSha256: hash, extension: 'jpg' }
    const descriptor = await store.put(ref, { size: image.length, sha256: hash }, body(image))
    expect(descriptor.contentType).toBe('image/jpeg')
    expect(descriptor.objectKey).toContain('/derived/v1/')
    expect(await store.put(ref, { size: image.length, sha256: hash }, body(image))).toEqual(descriptor)
    expect(await store.head(ref)).toEqual(descriptor)
    const ranged = await store.get(ref, { offset: 2, length: 3 })
    expect(new Uint8Array(await ranged!.arrayBuffer())).toEqual(image.slice(2, 5))
    expect(await revisions.head(original)).toEqual(originalInfo)
    const storedOriginal = await revisions.get(original)
    if (!storedOriginal || !('body' in storedOriginal)) throw new Error('missing original')
    expect(new Uint8Array(await storedOriginal.arrayBuffer())).toEqual(source)
    await expect(store.put(ref, { size: image.length, sha256: '0'.repeat(64) }, body(image))).rejects.toMatchObject({ code: 'invalid_input' })
    await revisions.deleteRevision(revision)
    expect(await store.head(ref)).toEqual(descriptor)
  })
})
