import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { decideRead, type ReadCredentials } from "../../domains/catalogue/read"
import { PublicationService } from "../../domains/publication"
import type { BeginCommand, PublicationDeps } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, bootstrap, configs, instanceId, jwks, teamIdentity } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument, storedBytes } from "./fixtures/publication"

const credentials: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }
beforeEach(async () => { await bootstrap() })

async function setup() {
  const time = clock(10_000)
  const { read, manage } = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  return { publication: new PublicationService(deps), read, store }
}

async function provider(publication: PublicationService, assetPath: string) {
  const page = await documentCommand(`provider-${assetPath}`, "/docs/provider.html", "provider document")
  const asset = await content("provider asset")
  const command: BeginCommand = { ...page.command, files: [...page.command.files, { path: assetPath, kind: "asset", size: asset.size, sha256: asset.sha256, contentType: "application/javascript", source: "client" }], edges: [{ ownerPageId: page.pageId, path: assetPath, providerArtifactId: null }] }
  const session = await publication.begin(actor, command)
  await publication.upload(actor, session.sessionId, "/docs/provider.html", body(page.bytes))
  await publication.upload(actor, session.sessionId, assetPath, body(asset.bytes))
  await publication.seal(actor, session.sessionId)
  const receipt = await publication.commit(actor, session.sessionId)
  return { session, receipt, asset }
}

describe("publication namespace conflicts", () => {
  it("rejects a competing artefact's resource under an owned subtree", async () => {
    const { publication, read, store } = await setup()
    const assetPath = "/a/claimed/foreign.js"
    const subtree = await documentCommand("foreign-subtree", "/a/claimed/index.html", "owner")
    const asset = await content("owner asset")
    const original: BeginCommand = { ...subtree.command, files: [...subtree.command.files, { path: assetPath, kind: "asset", size: asset.size, sha256: asset.sha256, contentType: "application/javascript", source: "client" }], edges: [{ ownerPageId: subtree.pageId, path: assetPath, providerArtifactId: null }] }
    const owner = await publication.begin(actor, original)
    await publication.upload(actor, owner.sessionId, "/a/claimed/index.html", body(subtree.bytes))
    await publication.upload(actor, owner.sessionId, assetPath, body(asset.bytes))
    await publication.seal(actor, owner.sessionId)
    await publication.commit(actor, owner.sessionId)
    const contender = await documentCommand("foreign-contender", "/docs/contender.html", "contender")
    const claim: BeginCommand = { ...contender.command, files: [...contender.command.files, original.files[1]], edges: [{ ownerPageId: contender.pageId, path: assetPath, providerArtifactId: null }] }
    await expect(publication.begin(actor, claim)).rejects.toMatchObject({ code: "conflict" })
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "claimed" }, candidates: ["/a/claimed/index.html"], fragmentPath: null }, { ...credentials, team: teamIdentity }, null)).toMatchObject({ kind: "allow", plan: { revisionId: owner.revisionId } })
    expect(await storedBytes(store, { artifactId: owner.artifactId, revisionId: owner.revisionId, kind: "resource", path: assetPath })).toEqual(asset.bytes)
  })

  it("rejects an external provider under subtree ownership without changing either active artefact", async () => {
    const { publication, read, store } = await setup()
    const assetPath = "/shared/widget.js"
    const owner = await provider(publication, assetPath)
    const page = await documentCommand("consumer-original", "/a/consumer/index.html", "consumer original")
    const initial = await publishDocument(publication, actor, page.command, page.bytes)
    const next: BeginCommand = { ...page.command, idempotencyKey: "consumer-foreign-provider", artifactId: initial.receipt.artifactId, expectedRevisionId: initial.receipt.revisionId, expectedContentVersion: initial.receipt.contentVersion, pages: [{ ...page.command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }], edges: [{ ownerPageId: page.pageId, path: assetPath, providerArtifactId: owner.receipt.artifactId }] }
    await expect((async () => {
      const session = await publication.begin(actor, next)
      await publication.upload(actor, session.sessionId, "/a/consumer/index.html", body(page.bytes))
      await publication.seal(actor, session.sessionId)
      await publication.commit(actor, session.sessionId)
    })()).rejects.toMatchObject({ code: "forbidden" })
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "consumer" }, candidates: ["/a/consumer/index.html"], fragmentPath: null }, { ...credentials, team: teamIdentity }, null)).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId } })
    expect(await storedBytes(store, { artifactId: owner.session.artifactId, revisionId: owner.session.revisionId, kind: "resource", path: assetPath })).toEqual(owner.asset.bytes)
  })
  it("rejects all-drop activation and requires explicit unpublish", async () => {
    const { publication, read } = await setup()
    const page = await documentCommand("all-drop-original", "/a/alone/index.html", "still live")
    const initial = await publishDocument(publication, actor, page.command, page.bytes)
    const command: BeginCommand = { idempotencyKey: "all-drop", artifactId: initial.session.artifactId, expectedRevisionId: initial.session.revisionId, expectedContentVersion: initial.receipt.contentVersion, files: [], pages: [{ pageId: page.pageId, disposition: "drop", documentPath: null, metadata: null, expectedPolicyEpoch: 0 }], edges: [] }
    await expect(publication.begin(actor, command)).rejects.toMatchObject({ code: "invalid_state", detail: "publication_without_page" })
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "alone" }, candidates: ["/a/alone/index.html"], fragmentPath: null }, { ...credentials, team: teamIdentity }, null)).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId } })
    const receipt = await publication.unpublish(actor, { idempotencyKey: "all-drop-unpublish", artifactId: initial.session.artifactId, expectedContentVersion: initial.receipt.contentVersion })
    expect(receipt).toMatchObject({ revisionId: null, contentVersion: initial.receipt.contentVersion + 1 })
  })

  it("refuses residual resources under a dropped subtree and leaves both pages active", async () => {
    const { publication, read, store } = await setup()
    const keep = await documentCommand("resulting-routes", "/a/kept/index.html", "kept")
    const drop = await documentCommand("drop-page", "/a/drop/index.html", "dropped")
    const asset = await content("residual")
    const assetPath = "/a/drop/asset.js"
    const command: BeginCommand = { ...keep.command, files: [...keep.command.files, ...drop.command.files, { path: assetPath, kind: "asset", sha256: asset.sha256, size: asset.size, contentType: "application/javascript", source: "client" }], pages: [...keep.command.pages, ...drop.command.pages], edges: [{ ownerPageId: drop.pageId, path: assetPath, providerArtifactId: null }] }
    const session = await publication.begin(actor, command)
    await publication.upload(actor, session.sessionId, "/a/kept/index.html", body(keep.bytes))
    await publication.upload(actor, session.sessionId, "/a/drop/index.html", body(drop.bytes))
    await publication.upload(actor, session.sessionId, assetPath, body(asset.bytes))
    await publication.seal(actor, session.sessionId)
    const receipt = await publication.commit(actor, session.sessionId)
    const update: BeginCommand = { idempotencyKey: "resulting-drop", artifactId: session.artifactId, expectedRevisionId: session.revisionId, expectedContentVersion: receipt.contentVersion, files: [keep.command.files[0], command.files[2]], pages: [{ ...keep.command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }, { pageId: drop.pageId, disposition: "drop", documentPath: null, metadata: null, expectedPolicyEpoch: 0 }], edges: [] }
    await expect(publication.begin(actor, update)).rejects.toMatchObject({ code: "conflict" })
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "drop" }, candidates: ["/a/drop/index.html"], fragmentPath: null }, { ...credentials, team: teamIdentity }, null)).toMatchObject({ kind: "allow", plan: { revisionId: session.revisionId } })
    expect(await storedBytes(store, { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path: assetPath })).toEqual(asset.bytes)
  })
})
