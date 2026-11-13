import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, disablePrincipal, readPagePolicy, revokeRole, setVisibility } from "../../domains/catalogue/commands"
import { decideRead } from "../../domains/catalogue/read"
import { PublicationService } from "../../domains/publication"
import type { BeginCommand, PublicationDeps } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, authenticatedActor, bootstrap, configs, instanceId, jwks, teamIdentity } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument, storedBytes } from "./fixtures/publication"

const path = "/a/authority/index.html"
async function activeRevision() {
  return decideRead(env.DB, (await configs()).read, { kind: "page", route: { kind: "subtree", slug: "authority" }, candidates: [path], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)
}

beforeEach(async () => { await bootstrap() })

async function setup() {
  const time = clock(10_000)
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: (await configs()).manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  return { publication: new PublicationService(deps), deps, store }
}

describe("publication authority freshness", () => {
  it.each(["seal", "commit"] as const)("refuses %s after a page policy epoch changes", async (phase) => {
    const { publication, deps, store } = await setup()
    const first = await documentCommand(`acl-initial-${phase}`, path, "old")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const next = await content("new")
    const command: BeginCommand = { ...first.command, idempotencyKey: `acl-update-${phase}`, artifactId: initial.receipt.artifactId, expectedRevisionId: initial.receipt.revisionId, expectedContentVersion: initial.receipt.contentVersion, files: [{ ...first.command.files[0], size: next.size, sha256: next.sha256 }], pages: [{ ...first.command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }] }
    const session = await publication.begin(actor, command)
    await publication.upload(actor, session.sessionId, path, body(next.bytes))
    if (phase === "commit") await publication.seal(actor, session.sessionId)
    await setVisibility(deps, actor, { artifactId: initial.receipt.artifactId, pageId: first.pageId, expectedPolicyEpoch: 0, visibility: "public" })
    await expect(phase === "seal" ? publication.seal(actor, session.sessionId) : publication.commit(actor, session.sessionId)).rejects.toThrow()
    expect(await readPagePolicy(deps, actor, first.pageId)).toMatchObject({ visibility: "public", policyEpoch: 1 })
    expect(await activeRevision()).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId } })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it.each([["seal", "role"], ["seal", "principal"], ["commit", "role"], ["commit", "principal"]] as const)("refuses %s after %s revocation", async (phase, revocation) => {
    const { publication, deps, store } = await setup()
    const first = await documentCommand(`role-initial-${phase}`, path, "old")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const person = await authenticatedActor(`role-${phase}`)
    const grant = await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const publisher = await authenticatedActor(`role-${phase}`)
    const next = await content("new")
    const command: BeginCommand = { ...first.command, idempotencyKey: `role-update-${phase}`, artifactId: initial.receipt.artifactId, expectedRevisionId: initial.receipt.revisionId, expectedContentVersion: initial.receipt.contentVersion, files: [{ ...first.command.files[0], size: next.size, sha256: next.sha256 }], pages: [{ ...first.command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }] }
    const session = await publication.begin(publisher, command)
    await publication.upload(publisher, session.sessionId, path, body(next.bytes))
    if (phase === "commit") await publication.seal(publisher, session.sessionId)
    if (revocation === "role") await revokeRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: grant.roleGrantId })
    else await disablePrincipal(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1 })
    const refreshed = await authenticatedActor(`role-${phase}`)
    await expect(phase === "seal" ? publication.seal(refreshed, session.sessionId) : publication.commit(refreshed, session.sessionId)).rejects.toThrow()
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
    expect(await readPagePolicy(deps, actor, first.pageId)).toMatchObject({ visibility: "private" })
    expect(await activeRevision()).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId } })
  })

  it.each(["revoke", "epoch"] as const)("replays scoped unpublish before %s but not after authority changes", async (change) => {
    const { publication, deps } = await setup()
    const first = await documentCommand("receipt-original", path, "private")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const person = await authenticatedActor("scoped-replay")
    const grant = await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId: first.pageId } })
    const publisher = await authenticatedActor("scoped-replay")
    const command = { idempotencyKey: "scoped-unpublish", artifactId: initial.receipt.artifactId, expectedContentVersion: initial.receipt.contentVersion }
    const receipt = await publication.unpublish(publisher, command)
    expect(await publication.unpublish(publisher, command)).toEqual(receipt)
    if (change === "revoke") await revokeRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: grant.roleGrantId })
    else await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, role: "publisher", scope: { kind: "installation" } })
    const refreshed = await authenticatedActor("scoped-replay")
    await expect(publication.unpublish(refreshed, command)).rejects.toThrow()
  })
})
