import { describe, expect, it } from "vitest"
import worker from "../../adapters/http/manageWorker"
import { admitImportSelection, buildImportCompletion, type ApprovedImportInventory, type ImportApproval, type ImportSelection } from "../../domains/catalogue/import"
import { handleRead } from "../../adapters/http/readWorker"
import { RevisionStore } from "../../domains/store/revision-store"
import { authenticateImportRead } from "../../domains/catalogue/principals"
import { revokeShare } from "../../domains/catalogue/commands"
import { shareKeyDigests } from "../../domains/catalogue/share-secrets"
import { newId } from "../../domains/catalogue/ids"
import { importPreviewOwned } from "../../domains/catalogue/previews"
import { shortlinkDestinationDigest } from "../../domains/catalogue/shortlinks"
import { actor, configs, instanceId, jwks, manageRequest } from "./fixtures/catalogue"
import { importResult, syntheticImport } from "./fixtures/import"
import { content } from "./fixtures/publication"
import { env, request, setupHttp, signed } from "./fixtures/manage-http"

setupHttp()
const key = "synthetic-original-key"

interface Trace { label: string; seen: Set<string> }
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
async function tracedCall(fixture: {call:(jwt:string,value:unknown)=>Promise<Response>}, jwt:string, op:string, selection:unknown, cursor:string|null, trace?:Trace) {
  if (!trace) return fixture.call(jwt, {op,selection,cursor})
  const start = performance.now()
  if (cursor) trace.seen.add(`${op}\0${cursor}`)
  try { return await fixture.call(jwt, {op,selection,cursor}) }
  finally { console.info(`[import-metadata:${trace.label}] ${op} request ${Math.round(performance.now()-start)}ms bytes=${byteLength({op,selection,cursor})}`) }
}

async function complete(fixture: { call: (jwt: string, value: unknown) => Promise<Response>; selection: unknown }, jwt: string, trace?:Trace) {
  let cursor: string | null = null
  for (let i = 0; i < 256; i++) {
    const response = await tracedCall(fixture, jwt, "apply", fixture.selection, cursor, trace)
    const text = await response.clone().text()
    expect(text).not.toContain(key)
    const result = await importResult(response)
    if (result.state === "committed") return result
    expect(["checking", "staging"]).toContain(result.state)
    cursor = result.nextCursor
  }
  throw new Error("synthetic import did not complete")
}

async function check(fixture: {call:(jwt:string,value:unknown)=>Promise<Response>;selection:unknown}, jwt:string, trace?:Trace) {
  let cursor: string | null = null
  for (let i = 0; i < 256; i++) {
    const result = await importResult(await tracedCall(fixture, jwt, "dry_run", fixture.selection, cursor, trace))
    if (result.state !== "checking") return result
    cursor = result.nextCursor
  }
  throw new Error("synthetic dry-run did not complete")
}
interface Fixture {
  readonly selection: ImportSelection
  readonly inventory: ApprovedImportInventory
  readonly approval: Record<string, unknown>
  readonly pageId: string
  readonly bindings: Record<string, unknown> & { FORGE_IMPORT_SOURCE: R2Bucket; FORGE_IMPORT_INVENTORIES: string }
}

async function repin(fixture: Fixture, selection: ImportSelection, inventory: ApprovedImportInventory) {
  const encoded = JSON.stringify(inventory)
  const object = await fixture.bindings.FORGE_IMPORT_SOURCE.put(`synthetic/${selection.planId}.json`, encoded)
  if (!object) throw new Error("Synthetic inventory upload failed")
  const approval = { ...fixture.approval, objectKey: object.key, objectVersion: object.version, sha256: (await content(encoded)).sha256 } as ImportApproval
  const bindings = { ...fixture.bindings, FORGE_IMPORT_INVENTORIES: JSON.stringify([approval]) }
  const call = (jwt: string, value: unknown) => worker.fetch(request("/api/maintenance/import", "POST", jwt, JSON.stringify(value), { "Content-Type": "application/json" }), bindings)
  return { selection, call, approval }
}

async function updatePlan(fixture: Fixture, publication: { artifactId: string; revisionId: string; contentVersion: number }, planId: string) {
  const page = await env.DB.prepare("SELECT policy_epoch FROM pages WHERE page_id=?").bind(fixture.pageId).first<{policy_epoch:number}>()
  if (!page) throw new Error("missing page")
  const command = { ...fixture.selection.command, idempotencyKey: planId, artifactId: publication.artifactId, expectedRevisionId: publication.revisionId, expectedContentVersion: publication.contentVersion, files: fixture.selection.command.files.map(f => ({ ...f, source: "base" as const })), pages: fixture.selection.command.pages.map(p => ({ ...p, disposition: "keep" as const, expectedPolicyEpoch: page.policy_epoch })) }
  const selection = { ...fixture.selection, planId, command }
  const inventory = { ...fixture.inventory, command, files: [], operations: fixture.inventory.operations.map(op => op.kind === "page_policy" ? { ...op, policy: { ...op.policy, expectedPolicyEpoch: page.policy_epoch } } : op) }
  return { selection, inventory }
}

async function twoPageImport(trace?:Trace) {
  const started = performance.now()
  const seed = await syntheticImport()
  const pageId = newId("pg"), grantId = newId("gr"), pagePath = "/docs/other.html", cover = "/docs/noncanonical.png", asset = "/docs/untouched.css"
  const source = seed.inventory.files[0]
  const document = { ...seed.selection.command.files[0], path:pagePath }
  const image = { ...document, path:cover, kind:"asset" as const, contentType:"image/png" }
  const css = { ...image, path:asset, contentType:"text/css" }
  const edges = [{ownerPageId:pageId,path:cover,providerArtifactId:null},{ownerPageId:pageId,path:asset,providerArtifactId:null}]
  const command = { ...seed.selection.command, files:[...seed.selection.command.files,document,image,css], pages:[...seed.selection.command.pages,{pageId,disposition:"new" as const,documentPath:pagePath,metadata:{},expectedPolicyEpoch:null}], edges }
  const selection = {...seed.selection,command}
  const inventory: ApprovedImportInventory = {...seed.inventory,command,files:[...seed.inventory.files,{...source,...document},{...source,...image},{...source,...css}],pageMappings:[...seed.inventory.pageMappings,{sourcePageId:"source-other",pageId,documentPath:pagePath,route:pagePath,ownershipEvidenceRef:"synthetic-other"}],edgeEvidence:edges.map(edge => ({...edge,evidenceRef:"synthetic-edge"})),operations:[...seed.inventory.operations,{kind:"page_policy",policy:{operationId:"other-policy",sourcePageId:"source-other",pageId,grantId,expectedPolicyEpoch:null,visibility:{captured:true,value:"shared",metadataV:"shared",expiresAt:null},share:{captured:true,key,expiresAt:null}}},{kind:"preview_selection",operationId:"other-preview",pageId,path:cover}]}
  const fixture: Fixture = {...seed,selection,inventory}
  const jwt = await signed()
  if (trace) console.info(`[import-metadata:${trace.label}] fixture ${Math.round(performance.now()-started)}ms`)
  const first = await complete(await repin(fixture,selection,inventory),jwt,trace)
  return {seed,pageId,pagePath,cover,asset,source,selection,inventory,fixture,jwt,first}
}

describe("synthetic selected import metadata", () => {
  it("checks preview ownership against the proposed tree graph", async () => {
    const fixture = await syntheticImport()
    const image = { path: "/images/noncanonical.png", kind: "asset" as const, contentType: "image/png", size: 1, sha256: "a".repeat(64), source: "client" as const }
    const command = { ...fixture.selection.command, pages: fixture.selection.command.pages.map(page => ({ ...page, documentPath: "/docs/index.html" })), files: [...fixture.selection.command.files, image] }
    expect(importPreviewOwned(command, fixture.pageId, image.path)).toBe(false)
    expect(importPreviewOwned({ ...command, edges: [...command.edges, { ownerPageId: fixture.pageId, path: image.path, providerArtifactId: null }] }, fixture.pageId, image.path)).toBe(true)
  })
  it("blocks an unowned tree preview through the import endpoint", async () => {
    const fixture = await syntheticImport()
    const documentPath = "/docs/index.html", imagePath = "/images/noncanonical.png"
    const document = { ...fixture.selection.command.files[0], path: documentPath }
    const image = { ...document, path: imagePath, kind: "asset" as const, contentType: "image/png" }
    const command = { ...fixture.selection.command, files: [document, image], pages: fixture.selection.command.pages.map(page => ({ ...page, documentPath })) }
    const selection = { ...fixture.selection, command }
    const sourceFile = fixture.inventory.files[0]
    const inventory = { ...fixture.inventory, command, pageMappings: fixture.inventory.pageMappings.map(mapping => ({ ...mapping, documentPath, route: documentPath })), files: [{ ...sourceFile, ...document }, { ...sourceFile, ...image }], operations: [...fixture.inventory.operations, { kind: "preview_selection" as const, operationId: "unowned-preview", pageId: fixture.pageId, path: imagePath }] }
    const admitted = await repin(fixture, selection, inventory)
    const result = await check(admitted, await signed())
    expect(result.state).toBe("blocked")
    expect(result.issues).toContainEqual({ code: "preview_not_owned", pageId: fixture.pageId, path: imagePath })
  })
  it("preserves an untouched tree page, its asset edge and original preview, and requires explicit removal", async () => {
    const trace: Trace = {label:"tree",seen:new Set()}
    const {seed,pageId,pagePath,cover,asset,inventory,fixture,jwt,first} = await twoPageImport(trace)
    const rivalPage = newId("pg")
    const rivalDocument = {...seed.selection.command.files[0],path:pagePath}
    const rivalCommand = {...seed.selection.command,files:[rivalDocument],pages:seed.selection.command.pages.map(p => ({...p,pageId:rivalPage,documentPath:pagePath}))}
    const rivalSelection = {...seed.selection,planId:"occupied-tree",command:rivalCommand}
    const rivalInventory = {...seed.inventory,sourceArtifactId:"other-source",command:rivalCommand,files:[{...seed.inventory.files[0],...rivalDocument}],pageMappings:seed.inventory.pageMappings.map(m => ({...m,pageId:rivalPage,documentPath:pagePath,route:pagePath})),operations:seed.inventory.operations.map(op => op.kind === "page_policy" ? {...op,policy:{...op.policy,pageId:rivalPage}} : op)}
    const collision = await check(await repin(seed,rivalSelection,rivalInventory),jwt,trace)
    expect(collision.state).toBe("blocked")
    const next = await updatePlan(fixture,first.publication,"preserve-other")
    const updateInventory = {...next.inventory,operations:[]}
    const updated = await complete(await repin(fixture,next.selection,updateInventory),jwt,trace)
    expect(await env.DB.prepare("SELECT original_path FROM preview_selections WHERE page_id=? AND revision_id=?").bind(pageId,updated.publication.revisionId).first()).toEqual({original_path:cover})
    const readConfig = await configs(), readStore = new RevisionStore(env.REVISION_BYTES,instanceId)
    const readDeps = {db:env.DB,config:readConfig.read,jwks,nowSeconds:() => Math.floor(Date.now()/1000),store:readStore}
    const card = await handleRead(new Request(`https://forge.example.test/s/docs/other.html/${key}`,{headers:{"User-Agent":"Slackbot"}}),readDeps)
    expect(card.status).toBe(200)
    const imageUrl = /<meta property="og:image" content="([^"]+)"/.exec(await card.text())?.[1].replaceAll("&amp;","&")
    expect(imageUrl).toBeTruthy()
    const preview = await handleRead(new Request(imageUrl!),readDeps)
    expect(preview.status).toBe(200)
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(seed.bytes)
    expect(await env.DB.prepare("SELECT path FROM mounts WHERE path=? AND artifact_id=?").bind(asset,updated.publication.artifactId).first()).toEqual({path:asset})
    expect(await env.DB.prepare("SELECT path FROM resource_owners WHERE owner_revision_id=? AND owner_page_id=? AND path=?").bind(updated.publication.revisionId,pageId,asset).first()).toEqual({path:asset})
    const omitted = await updatePlan(fixture,updated.publication,"omit-other-asset")
    const omittedCommand = {...omitted.selection.command,files:omitted.selection.command.files.filter(f => f.path !== asset),edges:omitted.selection.command.edges.filter(e => e.path !== asset)}
    const omittedSelection = {...omitted.selection,command:omittedCommand}
    const omittedInventory = {...omitted.inventory,command:omittedCommand,operations:[],edgeEvidence:inventory.edgeEvidence.filter(e => e.path !== asset)}
    const blocked = await check(await repin(fixture,omittedSelection,omittedInventory),jwt,trace)
    expect(blocked.state).toBe("blocked")
    expect(blocked.issues).toContainEqual({code:"resource_removal_undeclared",path:asset})
    const approved = {...omittedInventory,removals:[{kind:"resource" as const,path:asset,evidenceRef:"approved-resource-removal"},{kind:"edge" as const,ownerPageId:pageId,path:asset,providerArtifactId:null,evidenceRef:"approved-edge-removal"}]}
    const removed = await complete(await repin(fixture,omittedSelection,approved),jwt,trace)
    expect(await env.DB.prepare("SELECT path FROM mounts WHERE path=?").bind(asset).first()).toBeNull()
    expect(await env.DB.prepare("SELECT path FROM resource_owners WHERE owner_revision_id=? AND owner_page_id=? AND path=?").bind(removed.publication.revisionId,pageId,asset).first()).toBeNull()
  }, 30000)
  it("composes restore and imported policy epochs and replays the result", async () => {
    const {seed,source,selection,inventory,fixture,jwt,first} = await twoPageImport()
    const base = await updatePlan(fixture,first.publication,"drop-base")
    const current = await env.DB.prepare("SELECT policy_epoch FROM pages WHERE page_id=?").bind(seed.pageId).first<{policy_epoch:number}>()
    if (!current) throw new Error("missing page")
    const docPath = seed.selection.command.files[0].path
    const dropCommand = {...base.selection.command,idempotencyKey:"drop-first",expectedRevisionId:first.publication.revisionId,expectedContentVersion:first.publication.contentVersion,files:base.selection.command.files.filter(f => f.path !== docPath),pages:base.selection.command.pages.map(p => p.pageId === seed.pageId ? {...p,disposition:"drop" as const,documentPath:null,metadata:null,expectedPolicyEpoch:current.policy_epoch} : p)}
    const dropSelection = {...selection,planId:"drop-first",command:dropCommand}
    const dropInventory = {...inventory,command:dropCommand,files:[],operations:[],pageMappings:inventory.pageMappings.filter(m => m.pageId !== seed.pageId),removals:[{kind:"resource" as const,path:docPath,evidenceRef:"drop-document"}]}
    const dropped = await complete(await repin(fixture,dropSelection,dropInventory),jwt)
    const tombstone = await env.DB.prepare("SELECT policy_epoch,tombstoned_at FROM pages WHERE page_id=?").bind(seed.pageId).first<{policy_epoch:number;tombstoned_at:number|null}>()
    if (!tombstone || tombstone.tombstoned_at === null) throw new Error("page was not retired")
    const restoreCommand = {...dropCommand,idempotencyKey:"restore-first",expectedRevisionId:dropped.publication.revisionId,expectedContentVersion:dropped.publication.contentVersion,files:[...dropCommand.files,seed.selection.command.files[0]],pages:dropCommand.pages.map(p => p.pageId === seed.pageId ? {...p,disposition:"restore" as const,documentPath:docPath,metadata:{},expectedPolicyEpoch:tombstone.policy_epoch} : p)}
    const restoreSelection = {...selection,planId:"restore-first",command:restoreCommand}
    const restoreInventory: ApprovedImportInventory = {...inventory,command:restoreCommand,files:[source],operations:[{kind:"page_policy",policy:{operationId:"restore-public",sourcePageId:"source-page",pageId:seed.pageId,grantId:null,expectedPolicyEpoch:tombstone.policy_epoch,visibility:{captured:true,value:"public",metadataV:"public",expiresAt:null},share:{captured:true,key:null,expiresAt:null}}}]}
    const restoration = await repin(fixture,restoreSelection,restoreInventory)
    expect((await check(restoration,jwt)).state).toBe("ready")
    await complete(restoration,jwt)
    expect(await env.DB.prepare("SELECT visibility,policy_epoch,tombstoned_at FROM pages WHERE page_id=?").bind(seed.pageId).first()).toEqual({visibility:"public",policy_epoch:tombstone.policy_epoch+2,tombstoned_at:null})
    await complete(restoration,jwt)
  }, 30000)
  it("retains an exchanged tree share cookie across exact-grant import and revokes it immediately", async () => {
    const grantId = newId("gr"), path = "/docs/cookie.html"
    const seed = await syntheticImport(pageId => [{kind:"page_policy",policy:{operationId:"cookie-policy",sourcePageId:"source-page",pageId,grantId,expectedPolicyEpoch:null,visibility:{captured:true,value:"shared",metadataV:"shared",expiresAt:null},share:{captured:true,key,expiresAt:null}}}])
    const document = {...seed.selection.command.files[0],path}
    const command = {...seed.selection.command,files:[document],pages:seed.selection.command.pages.map(p => ({...p,documentPath:path}))}
    const selection = {...seed.selection,command}
    const inventory = {...seed.inventory,command,files:[{...seed.inventory.files[0],...document}],pageMappings:seed.inventory.pageMappings.map(m => ({...m,documentPath:path,route:path}))}
    const fixture: Fixture = {...seed,selection,inventory}
    const jwt = await signed()
    const first = await complete(await repin(fixture,selection,inventory),jwt)
    const config = await configs(), store = new RevisionStore(env.REVISION_BYTES,instanceId)
    const read = (url:string, init?:RequestInit) => handleRead(new Request(`https://forge.example.test${url}`,init),{db:env.DB,config:{...config.read,shareCookie:true},jwks,nowSeconds:() => Math.floor(Date.now()/1000),store})
    const exchange = await read(`/s/docs/cookie.html/${key}`,{headers:{"Sec-Fetch-Dest":"document"}})
    expect(exchange.status).toBe(302)
    const cookie = exchange.headers.get("set-cookie")?.split(";",1)[0]
    expect(cookie).toMatch(/^forge_share=/)
    expect((await read("/docs/cookie",{headers:{Cookie:cookie!}})).status).toBe(200)
    const next = await updatePlan(fixture,first.publication,"cookie-update")
    const update = await repin(fixture,next.selection,next.inventory)
    await complete(update,jwt)
    expect((await read("/docs/cookie",{headers:{Cookie:cookie!}})).status).toBe(200)
    const policy = await env.DB.prepare("SELECT policy_epoch FROM pages WHERE page_id=?").bind(seed.pageId).first<{policy_epoch:number}>()
    if (!policy) throw new Error("missing shared page")
    await revokeShare({db:env.DB,config:config.manage,jwks,now:Date.now},actor,{pageId:seed.pageId,artifactId:first.publication.artifactId,expectedPolicyEpoch:policy.policy_epoch,grantId})
    const denied = await read("/docs/cookie",{headers:{Cookie:cookie!,"If-None-Match":"*","Range":"bytes=0-3"}})
    expect([200,206,304]).not.toContain(denied.status)
  })
  it("continues metadata and bytes for a selection larger than one 128-item work window", async () => {
    const trace: Trace = {label:"large",seen:new Set()}
    const started = performance.now()
    const seed = await syntheticImport(undefined, 128)
    const transport = JSON.parse(seed.bindings.FORGE_MANAGE_TRANSPORT as string) as Record<string,number>
    const bindings = {...seed.bindings,FORGE_MANAGE_TRANSPORT:JSON.stringify({...transport,maxCommandBytes:131072})}
    const fixture = {...seed,call:(jwt:string,value:unknown) => worker.fetch(request("/api/maintenance/import","POST",jwt,JSON.stringify(value),{"Content-Type":"application/json"}),bindings)}
    console.info(`[import-metadata:large] fixture ${Math.round(performance.now()-started)}ms dto=${byteLength({op:"dry_run",selection:fixture.selection,cursor:null})} inventory=${byteLength(fixture.inventory)} commandLimit=131072 inventoryLimit=${fixture.approval.maxInventoryBytes}`)
    const jwt = await signed()
    expect((await check(fixture,jwt,trace)).state).toBe("ready")
    expect([...trace.seen].filter(cursor => cursor.startsWith("dry_run\0")).length).toBeGreaterThan(1)
    const result = await complete(fixture,jwt,trace)
    expect([...trace.seen].filter(cursor => cursor.startsWith("apply\0")).length).toBeGreaterThan(1)
    const revisionId = result.publication.revisionId, artifactId = result.publication.artifactId
    const resources = await env.DB.prepare("SELECT path,sha256,size FROM revision_resources WHERE revision_id=?").bind(revisionId).all<{path:string;sha256:string;size:number}>()
    expect(resources.results).toHaveLength(129)
    expect(new Map(resources.results.map(row => [row.path,[row.sha256,row.size]]))).toEqual(new Map(fixture.selection.command.files.map(file => [file.path,[file.sha256,file.size]])))
    const owners = await env.DB.prepare("SELECT path FROM resource_owners WHERE owner_revision_id=? AND owner_page_id=?").bind(revisionId,fixture.pageId).all<{path:string}>()
    expect(new Set(owners.results.map(row => row.path))).toEqual(new Set(fixture.selection.command.edges.map(edge => edge.path)))
    const store = new RevisionStore(env.REVISION_BYTES,instanceId)
    await Promise.all(fixture.extraBytes.map(async ({path,bytes}) => {
      const object = await store.get({kind:"resource",artifactId,revisionId,path})
      expect(object && "body" in object && object.body).toBeTruthy()
      if (!object || !("body" in object) || !object.body) throw new Error("missing imported bytes")
      expect(new Uint8Array(await new Response(object.body).arrayBuffer())).toEqual(bytes)
    }))
  }, 30000)
  it("rolls back if a kept base preview appears after completion was planned", async () => {
    const seed = await syntheticImport(undefined, 9)
    const files = seed.selection.command.files.map((file,index) => index === 1 ? {...file,contentType:"image/png"} : file)
    const command = {...seed.selection.command,files}
    const selection = {...seed.selection,command}
    const inventory = {...seed.inventory,command,files:seed.inventory.files.map((file,index) => index === 1 ? {...file,contentType:"image/png"} : file)}
    const fixture: Fixture = {...seed,selection,inventory}
    const jwt = await signed()
    const first = await complete(await repin(fixture,selection,inventory),jwt)
    const next = await updatePlan(fixture,first.publication,"preview-race")
    const candidate = await repin(fixture,next.selection,next.inventory)
    let cursor: string | null = null, staged: Record<string,any>
    do {
      staged = await importResult(await candidate.call(jwt,{op:"apply",selection:candidate.selection,cursor}))
      cursor = staged.nextCursor
    } while (staged.state === "checking")
    expect(staged.state).toBe("staging")
    const deps = {db:env.DB,config:(await configs()).manage,jwks,now:() => 10_000}
    const authority = await authenticateImportRead(await manageRequest(),deps)
    const admitted = await admitImportSelection(next.selection,next.inventory,candidate.approval,deps,authority)
    const target = {sessionId:staged.session.sessionId,artifactId:first.publication.artifactId,revisionId:staged.session.revisionId,planId:next.selection.planId,planDigest:admitted.planDigest,at:10_000,publicationReceipt:{artifactId:first.publication.artifactId,revisionId:staged.session.revisionId,contentVersion:first.publication.contentVersion+1,pages:[]}}
    const completion = await buildImportCompletion(deps,actor,admitted,target)
    await env.DB.prepare("INSERT INTO preview_selections(page_id,revision_id,original_path) VALUES (?,?,?)").bind(fixture.pageId,first.publication.revisionId,fixture.selection.command.files[1].path).run()
    await expect(env.DB.batch(completion.statements)).rejects.toThrow()
    expect(await env.DB.prepare("SELECT active_revision_id FROM artifacts WHERE artifact_id=?").bind(first.publication.artifactId).first()).toEqual({active_revision_id:first.publication.revisionId})
    expect(await env.DB.prepare("SELECT plan_id FROM publication_imports WHERE plan_id=?").bind(next.selection.planId).first()).toBeNull()
  })






  it("preserves the original share verifier and shortlink without rotating or duplicating either, and refuses replay after revoke", async () => {
    const destination = `https://forge.example.test/s/synthetic-import/${key}/`
    const digest = await shortlinkDestinationDigest(destination)
    const grantId = newId("gr")
    const seed = await syntheticImport(pageId => [
      { kind: "page_policy", policy: { operationId: "synthetic-policy", sourcePageId: "source-page", pageId, grantId, expectedPolicyEpoch: null, visibility: { captured: true, value: "shared", metadataV: "shared", expiresAt: null }, share: { captured: true, key, expiresAt: null } } },
      { kind: "shortlink", operationId: "synthetic-link", mapping: { mappingId: "synthetic-mapping", providerOrigin: "https://links.example.test", providerId: "provider-1", shortDomain: "links.example.test", shortCode: "original", shortUrl: "https://links.example.test/original", pageId, grantId, destination, source: "imported", observedAt: 1, destinationDigest: digest } },
    ], 1)
    const command = {...seed.selection.command,files:seed.selection.command.files.map((f,i) => i === 1 ? {...f,contentType:"application/octet-stream"} : f)}
    const selection = {...seed.selection,command}
    const inventory = {...seed.inventory,command,files:seed.inventory.files.map((f,i) => i === 1 ? {...f,contentType:"application/octet-stream"} : f)}
    const fixture: Fixture = {...seed,selection,inventory}
    const initial = await repin(fixture,selection,inventory)
    const jwt = await signed()
    const first = await complete(initial, jwt)
    await complete(initial, jwt)
    const next = await updatePlan(fixture, first.publication, "same-grant-update")
    const update = await repin(fixture, next.selection, next.inventory)
    expect((await check(update, jwt)).state).toBe("ready")
    const second = await complete(update, jwt)
    const config = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const read = (path:string, init?:RequestInit) => handleRead(new Request(`https://forge.example.test${path}`, init), {db:env.DB,config:{...config.read,shareCookie:true},jwks,nowSeconds:() => Math.floor(Date.now()/1000),store})
    const assetPath = `/s/synthetic-import/${key}/asset-0.css`
    const asset = await read(assetPath)
    expect(asset.status).toBe(200)
    const etag = asset.headers.get("etag")
    expect(etag).toBeTruthy()
    expect(await asset.text()).toContain("synthetic asset")
    expect((await read(assetPath, {method:"HEAD"})).status).toBe(200)
    expect((await read(assetPath, {headers:{Range:"bytes=0-3"}})).status).toBe(206)
    expect((await read(assetPath, {headers:{"If-None-Match":etag!}})).status).toBe(304)
    const mismatched = await updatePlan(fixture, second.publication, "mismatched-grant")
    const mismatchedInventory = { ...mismatched.inventory, operations:mismatched.inventory.operations.map(op => op.kind === "page_policy" ? {...op,policy:{...op.policy,share:{...op.policy.share,key:"different-original-key"}}} : op) }
    const mismatch = await check(await repin(fixture,mismatched.selection,mismatchedInventory),jwt)
    expect(mismatch.state).toBe("blocked")
    expect(mismatch.issues).toContainEqual({code:"grant_conflict",pageId:fixture.pageId})
    const grants = await env.DB.prepare("SELECT grant_id, key_hmac, revoked_at FROM share_grants WHERE page_id = ?").bind(fixture.pageId).all<{ grant_id: string; key_hmac: string; revoked_at: number | null }>()
    expect(grants.results).toHaveLength(1)
    expect(grants.results[0].key_hmac).toBe((await shareKeyDigests((await configs()).manage.shareVerifierKeys, "test-forge", key))[0].hmac)
    const links = await env.DB.prepare("SELECT provider_origin, provider_id, short_domain, short_code, short_url, destination, destination_digest FROM shortlink_mappings").all()
    expect(links.results).toEqual([{ provider_origin: "https://links.example.test", provider_id: "provider-1", short_domain: "links.example.test", short_code: "original", short_url: "https://links.example.test/original", destination, destination_digest: digest }])
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: Date.now }
    const policy = await env.DB.prepare("SELECT policy_epoch FROM pages WHERE page_id = ?").bind(fixture.pageId).first<{ policy_epoch: number }>()
    if (!policy) throw new Error("missing imported page")
    await revokeShare(deps, actor, { pageId: fixture.pageId, artifactId: first.publication.artifactId, expectedPolicyEpoch: policy.policy_epoch, grantId: grants.results[0].grant_id })
    const replay = await update.call(jwt, { op: "apply", selection: update.selection, cursor: null })
    expect(replay.status).toBe(409)
    const revoked = await updatePlan(fixture, second.publication, "revoked-grant")
    const denied = await check(await repin(fixture,revoked.selection,revoked.inventory),jwt)
    expect(denied.state).toBe("blocked")
    expect(denied.issues).toContainEqual({code:"grant_conflict",pageId:fixture.pageId})
    for (const [method, headers] of [["GET",{}],["HEAD",{}],["GET",{Range:"bytes=0-3"}],["GET",{"If-None-Match":etag!}]] as const) {
      expect([200,206,304]).not.toContain((await read(assetPath,{method,headers})).status)
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM share_grants WHERE page_id = ? AND revoked_at IS NULL").bind(fixture.pageId).first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM shortlink_mappings").first()).toEqual({ n: 1 })
  })

  it("does not commit publication or receipts when an imported alias conflicts", async () => {
    const fixture = await syntheticImport(pageId => [
      { kind: "page_policy", policy: { operationId: "synthetic-public", sourcePageId: "source-page", pageId, grantId: null, expectedPolicyEpoch: null, visibility: { captured: true, value: "public", metadataV: "public", expiresAt: null }, share: { captured: true, key: null, expiresAt: null } } },
      { kind: "alias", operationId: "synthetic-alias", aliasKind: "redirect_exact", path: "/legacy", to: "/a/synthetic-import/", status: 302, targetPageId: pageId },
    ], 9)
    const jwt = await signed()
    let cursor: string | null = null
    let staged: Record<string, any>
    do {
      staged = await importResult(await fixture.call(jwt, { op: "apply", selection: fixture.selection, cursor }))
      cursor = staged.nextCursor
    } while (staged.state === "checking")
    expect(staged.state).toBe("staging")
    // Inject the competing metadata only after a real import session has staged bytes.
    await env.DB.prepare("INSERT INTO routes (kind,route_key,redirect_to,redirect_status,created_at) VALUES ('redirect_exact','/legacy','/other',302,1)").run()
    let failed = false
    for (let i = 0; i < 256; i++) {
      const response = await fixture.call(jwt, { op: "apply", selection: fixture.selection, cursor })
      if (response.status !== 200) { failed = true; break }
      const result = await importResult(response)
      if (result.state === "blocked") { failed = true; break }
      expect(["checking", "staging"]).toContain(result.state)
      cursor = result.nextCursor
    }
    expect(failed).toBe(true)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE active_revision_id IS NOT NULL").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM pages WHERE page_id = ?").bind(fixture.pageId).first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM catalogue_import_operations").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT redirect_to FROM routes WHERE kind = 'redirect_exact' AND route_key = '/legacy'").first()).toEqual({ redirect_to: "/other" })
  })
})
