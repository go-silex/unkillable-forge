import { env } from "cloudflare:workers"
import { beforeEach, expect, it } from "vitest"
import { PublicationService } from "../../domains/publication"
import type { PublicationDeps } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, bootstrap, configs, instanceId, jwks } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })

it.each(["removed", "live", "local"] as const)("checks %s provider at activation", async scenario => {
  const time = clock(10_000)
  const { manage } = await configs()
  const deps: PublicationDeps = { db: env.DB, config: manage, jwks, now: time.now, store: new RevisionStore(env.REVISION_BYTES, instanceId), publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  const publication = new PublicationService(deps)
  const provider = await documentCommand("edge-provider", "/provider.html", "provider")
  const asset = await content("shared asset")
  const assetPath = "/shared/style.css"
  const providerSession = await publication.begin(actor, { ...provider.command, files: [...provider.command.files, { path: assetPath, kind: "asset", sha256: asset.sha256, size: asset.size, contentType: "text/css", source: "client" }] })
  await publication.upload(actor, providerSession.sessionId, "/provider.html", body(provider.bytes))
  await publication.upload(actor, providerSession.sessionId, assetPath, body(asset.bytes))
  await publication.seal(actor, providerSession.sessionId)
  const published = await publication.commit(actor, providerSession.sessionId)

  const consumer = await documentCommand("edge-consumer", "/consumer.html", "consumer")
  const initial = await publishDocument(publication, actor, consumer.command, consumer.bytes)
  const local = await content("local asset")
  const localPath = "/local/style.css"
  const session = await publication.begin(actor, {
    ...consumer.command,
    idempotencyKey: "edge-consumer-update",
    artifactId: initial.receipt.artifactId,
    expectedRevisionId: initial.receipt.revisionId,
    expectedContentVersion: initial.receipt.contentVersion,
    files: scenario === "local" ? [...consumer.command.files, { path: localPath, kind: "asset", sha256: local.sha256, size: local.size, contentType: "text/css", source: "client" }] : consumer.command.files,
    pages: [{ pageId: consumer.pageId, disposition: "keep", documentPath: "/consumer.html", metadata: {}, expectedPolicyEpoch: 0 }],
    edges: [{ ownerPageId: consumer.pageId, path: scenario === "local" ? localPath : assetPath, providerArtifactId: scenario === "local" ? null : published.artifactId }],
  })
  await publication.upload(actor, session.sessionId, "/consumer.html", body(consumer.bytes))
  if (scenario === "local") await publication.upload(actor, session.sessionId, localPath, body(local.bytes))
  await publication.seal(actor, session.sessionId)
  if (scenario === "removed") {
    await publication.unpublish(actor, { idempotencyKey: "edge-provider-unpublish", artifactId: published.artifactId, expectedContentVersion: published.contentVersion })
    await expect(publication.commit(actor, session.sessionId)).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT active_revision_id,content_version FROM artifacts WHERE artifact_id=?").bind(session.artifactId).first()).toEqual({ active_revision_id: initial.receipt.revisionId, content_version: initial.receipt.contentVersion })
  } else {
    const committed = await publication.commit(actor, session.sessionId)
    expect(committed).toMatchObject({ revisionId: session.revisionId, contentVersion: initial.receipt.contentVersion + 1 })
  }
})
