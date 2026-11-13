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
  it("rejects a subtree claim covering a foreign mounted resource atomically", async () => {
    const { publication, read, store } = await setup()
    const assetPath = "/a/claimed/foreign.js"
    const tree = await documentCommand("foreign-before-release", "/docs/provider.html", "provider")
    const subtree = await documentCommand("foreign-subtree", "/a/claimed/index.html", "temporary")
    const asset = await content("foreign asset")
    const original: BeginCommand = { ...tree.command, files: [...tree.command.files, ...subtree.command.files, { path: assetPath, kind: "asset", size: asset.size, sha256: asset.sha256, contentType: "application/javascript", source: "client" }], pages: [...tree.command.pages, ...subtree.command.pages], edges: [{ ownerPageId: tree.pageId, path: assetPath, providerArtifactId: null }] }
    const initial = await publication.begin(actor, original)
    await publication.upload(actor, initial.sessionId, "/docs/provider.html", body(tree.bytes))
    await publication.upload(actor, initial.sessionId, "/a/claimed/index.html", body(subtree.bytes))
    await publication.upload(actor, initial.sessionId, assetPath, body(asset.bytes))
    await publication.seal(actor, initial.sessionId)
    const initialReceipt = await publication.commit(actor, initial.sessionId)
    const release: BeginCommand = { idempotencyKey: "release-subtree", artifactId: initial.artifactId, expectedRevisionId: initial.revisionId, expectedContentVersion: initialReceipt.contentVersion, files: original.files.filter(file => file.path !== "/a/claimed/index.html"), pages: [{ ...tree.command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }, { pageId: subtree.pageId, disposition: "drop", documentPath: null, metadata: null, expectedPolicyEpoch: 0 }], edges: original.edges }
    const owner = await publication.begin(actor, release)
    await publication.upload(actor, owner.sessionId, "/docs/provider.html", body(tree.bytes))
    await publication.upload(actor, owner.sessionId, assetPath, body(asset.bytes))
    await publication.seal(actor, owner.sessionId)
    await publication.commit(actor, owner.sessionId)
    const claim = await documentCommand("claim-subtree", "/a/claimed/index.html", "claim")
    await expect((async () => {
      const session = await publication.begin(actor, claim.command)
      await publication.upload(actor, session.sessionId, "/a/claimed/index.html", body(claim.bytes))
      await publication.seal(actor, session.sessionId)
      await publication.commit(actor, session.sessionId)
    })()).rejects.toThrow()
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "tree_page", pageRef: "docs/provider.html" }, candidates: ["/docs/provider.html"], fragmentPath: null }, { ...credentials, team: teamIdentity }, null)).toMatchObject({ kind: "allow", plan: { revisionId: owner.revisionId } })
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
    })()).rejects.toThrow()
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "consumer" }, candidates: ["/a/consumer/index.html"], fragmentPath: null }, { ...credentials, team: teamIdentity }, null)).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId } })
    expect(await storedBytes(store, { artifactId: owner.session.artifactId, revisionId: owner.session.revisionId, kind: "resource", path: assetPath })).toEqual(owner.asset.bytes)
  })
})
