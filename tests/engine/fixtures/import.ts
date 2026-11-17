import worker from "../../../adapters/http/manageWorker"
import type { ApprovedImportInventory, ImportOperation, ImportSelection } from "../../../domains/catalogue/import"
import { manageHttpBindings } from "./manage-http-bindings"
import { env, request } from "./manage-http"
import { content, documentCommand } from "./publication"

// Local workerd-only evidence: deliberately synthetic, never a historical approval.
export async function syntheticImport(operations?: (pageId: string) => ImportOperation[], extraFiles = 0) {
  const doc = await documentCommand("synthetic-import", "/a/synthetic-import/index.html", "<h1>synthetic import</h1>")
  const sourceKey = "synthetic/content/index.html"
  const source = await env.FORGE_IMPORT_SOURCE.put(sourceKey, doc.bytes)
  if (!source) throw new Error("Synthetic source upload failed")
  const files: ApprovedImportInventory["files"][number][] = [{ ...doc.command.files[0], sourceRef: sourceKey, sourceVersion: source.version, provenance: "synthetic-publication" }]
  const commandFiles = [...doc.command.files]
  const edges = [...doc.command.edges]
  const extraBytes: { path: string; bytes: Uint8Array<ArrayBuffer> }[] = []
  for (let i = 0; i < extraFiles; i++) {
    const path = `/a/synthetic-import/asset-${i}.css`
    const value = await content(`synthetic asset ${i}`)
    const object = await env.FORGE_IMPORT_SOURCE.put(`synthetic/content/asset-${i}.css`, value.bytes)
    if (!object) throw new Error("Synthetic asset upload failed")
    const file = { path, kind: "asset" as const, contentType: "text/css", size: value.size, sha256: value.sha256, source: "client" as const }
    commandFiles.push(file)
    files.push({ ...file, sourceRef: object.key, sourceVersion: object.version, provenance: "synthetic-publication" })
    edges.push({ ownerPageId: doc.pageId, path, providerArtifactId: null })
    extraBytes.push({ path, bytes: value.bytes })
  }
  const selection: ImportSelection = { version: 1, inventoryId: "synthetic-inventory", selectionId: "synthetic-selection", planId: "synthetic-plan", command: { ...doc.command, files: commandFiles, edges } }
  const inventory: ApprovedImportInventory = {
    version: 1, inventoryId: selection.inventoryId, selectionId: selection.selectionId,
    sourceInstance: "synthetic-source", sourceArtifactId: "synthetic-artifact", approvalRef: "synthetic-approval", kind: "synthetic",
    command: selection.command,
    pageMappings: [{ sourcePageId: "source-page", pageId: doc.pageId, documentPath: "/a/synthetic-import/index.html", route: "/a/synthetic-import/", ownershipEvidenceRef: "synthetic-ownership" }],
    edgeEvidence: edges.map(edge => ({ ...edge, evidenceRef: "synthetic-edge" })),
    evidence: { selectionDigest: "a".repeat(64), corpusDigest: "b".repeat(64), mappingRef: "synthetic-mapping", capturedAt: 1, complete: true, g1bRef: null },
    files,
    operations: operations?.(doc.pageId) ?? [{ kind: "page_policy", policy: { operationId: "synthetic-private", sourcePageId: "source-page", pageId: doc.pageId, grantId: null, expectedPolicyEpoch: null, visibility: { captured: true, value: "private", metadataV: "private", expiresAt: null }, share: { captured: true, key: null, expiresAt: null } } }],
  }
  const encoded = JSON.stringify(inventory)
  const inventoryObject = await env.FORGE_IMPORT_SOURCE.put("synthetic/inventory.json", encoded)
  if (!inventoryObject) throw new Error("Synthetic inventory upload failed")
  const digest = await content(encoded)
  const approval = { inventoryId: selection.inventoryId, selectionId: selection.selectionId, sourceInstance: inventory.sourceInstance, objectKey: inventoryObject.key, objectVersion: inventoryObject.version, sha256: digest.sha256, approvalRef: inventory.approvalRef, kind: "synthetic", g1bRef: null, maxInventoryBytes: 1024 * 1024 }
  const bindings = { ...manageHttpBindings, FORGE_IMPORT_SOURCE: env.FORGE_IMPORT_SOURCE, FORGE_IMPORT_INVENTORIES: JSON.stringify([approval]), DB: env.DB, REVISION_BYTES: env.REVISION_BYTES }
  const call = (jwt: string, value: unknown) => worker.fetch(request("/api/maintenance/import", "POST", jwt, JSON.stringify(value), { "Content-Type": "application/json" }), bindings)
  return { ...doc, selection, inventory, approval, sourceKey, sourceVersion: source.version, bindings, call, extraBytes }
}

export async function importResult(response: Response): Promise<Record<string, any>> {
  expectResponse(response)
  const payload = await response.json() as { ok: boolean; result: Record<string, any> }
  if (!payload.ok) throw new Error("import request failed")
  return payload.result
}

function expectResponse(response: Response) {
  if (response.status !== 200) throw new Error(`unexpected import HTTP status ${response.status}`)
}
