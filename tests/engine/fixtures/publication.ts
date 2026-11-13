import { newId } from "../../../domains/catalogue/ids"
import type { ManageActor } from "../../../domains/catalogue/principals"
import type { BeginCommand, Publication, PublicationReceipt, PublicationStatus } from "../../../domains/publication/types"
import { RevisionStore, type RevisionObjectRef } from "../../../domains/store/revision-store"

const encoder = new TextEncoder()

export async function content(value: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; size: number; sha256: string }> {
  const bytes = encoder.encode(value)
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return { bytes, size: bytes.byteLength, sha256: Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("") }
}

export function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
}

export async function storedBytes(store: RevisionStore, ref: RevisionObjectRef): Promise<Uint8Array | null> {
  const object = await store.get(ref)
  if (!object) return null
  if (!("body" in object)) throw new Error("Expected a revision object body")
  return new Uint8Array(await object.arrayBuffer())
}

export function clock(initial: number): { now: () => number; advance: (milliseconds: number) => void } {
  let current = initial
  return {
    now: () => current,
    advance: milliseconds => { current += milliseconds },
  }
}


export async function documentCommand(key: string, path: string, value: string): Promise<{ command: BeginCommand; bytes: Uint8Array<ArrayBuffer>; pageId: string }> {
  const file = await content(value)
  const pageId = newId("pg")
  return {
    bytes: file.bytes,
    pageId,
    command: {
      idempotencyKey: key,
      artifactId: null,
      expectedRevisionId: null,
      expectedContentVersion: 0,
      files: [{ path, kind: "document", sha256: file.sha256, size: file.size, contentType: "text/html", source: "client" }],
      pages: [{ pageId, disposition: "new", documentPath: path, metadata: {}, expectedPolicyEpoch: null }],
      edges: [],
    },
  }
}

export async function publishDocument(publication: Publication, actor: ManageActor, command: BeginCommand, bytes: Uint8Array): Promise<{ session: PublicationStatus; receipt: PublicationReceipt }> {
  const session = await publication.begin(actor, command)
  await publication.upload(actor, session.sessionId, command.files[0].path, body(bytes))
  await publication.seal(actor, session.sessionId)
  const receipt = await publication.commit(actor, session.sessionId)
  return { session, receipt }
}