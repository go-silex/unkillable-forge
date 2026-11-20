// Translate one explicit operator selection into ordinary BeginCommand,
// ImportSelection and inventory drafts. This module does not open files,
// discover captures, decide access, or contact a provider. Native R2 versions
// are filled only by assignSourcePins after a real local PUT.
import { parseRequest, isReservedShellPath, subtreeSlugOf } from "../domains/catalogue/routing/grammar.ts"
import { importPreviewOwned, orderedOriginalImageCandidatePaths } from "../domains/catalogue/previews.ts"
import { conflictingImportOperationIndexes } from "../domains/catalogue/import-operation-set.ts"
import { validateReaderProfile } from "../domains/catalogue/instance-config.ts"
import { documentRouteOf } from "../domains/catalogue/revision-paths.ts"
import { validateBeginCommand, isPublicationToken } from "../domains/publication/staging.ts"
import { isValidAliasPath, isValidAliasDestination, aliasMatchesPath, aliasLocation } from "../domains/catalogue/alias-validation.ts"
import { validShortlinkIdentity } from "../domains/catalogue/shortlink-identity.ts"
import { newId, isCatalogueId } from "../domains/catalogue/ids.ts"
import { isUnicodeScalarString } from "../domains/store/revision-store.ts"


const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
const SHA256 = /^[a-f0-9]{64}$/
const SHARE_KEY = /^[A-Za-z0-9_-]{8,128}$/
const ENGINE_ID = /^(?:pg|ar|gr)_[a-z2-7]{26}$/
const MIME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*;[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]+|"(?:[\t !#-\[\]-~]|\\[\t -~])*"))*[ \t]*$/
const LIMITS = { files: 10000, pages: 1000, edges: 20000, fileBytes: 32 * 1024 * 1024, cursor: 16384, owners: 4 }

export const SELECTED_IMPORT_SCHEMA = 1

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function text(value, max = 1024) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
}
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value)
}
function hex(value) {
  return typeof value === "string" && SHA256.test(value)
}
function one(value, allowed) {
  return typeof value === "string" && allowed.includes(value)
}
export function stable(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  throw new Error("unstable_value")
}
function utf8(value) {
  return new TextEncoder().encode(value).length
}
function depth(value) {
  const stack = [[value, 1]]
  let max = 1
  while (stack.length) {
    const [current, level] = stack.pop()
    if (level > max) max = level
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) stack.push([child, level + (child !== null && typeof child === "object" ? 1 : 0)])
    }
  }
  return max
}
function opaque() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let bits = 0
  let value = 0
  let encoded = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      encoded += ALPHABET[(value >>> bits) & 31]
    }
  }
  if (bits) encoded += ALPHABET[(value << (5 - bits)) & 31]
  return encoded
}
const engineId = newId
export function emptyLedger() {
  return { version: 2, pages: {}, grants: {}, idempotencyKeys: {}, inventoryIds: {}, selectionIds: {}, planIds: {}, operationIds: {} }
}
function validLedgerTuple(table, tuple) {
  if (!Array.isArray(tuple) || !text(tuple[0]) || !text(tuple[1])) return false
  if (table === "pages" || table === "grants") return tuple.length === 3 && text(tuple[2]) && isUnicodeScalarString(tuple[2]) && !ENGINE_ID.test(tuple[2])
  if (!text(tuple[2]) || !hex(tuple[3])) return false
  if (table !== "operationIds") return tuple.length === 4
  const tail = tuple.slice(4)
  if (tail[0] === "policy") return tail.length === 2 && text(tail[1]) && isUnicodeScalarString(tail[1]) && !ENGINE_ID.test(tail[1])
  if (tail[0] === "shortlink") return tail.length === 2 && text(tail[1])
  if (tail[0] === "preview") return tail.length === 3 && text(tail[1]) && isUnicodeScalarString(tail[1]) && !ENGINE_ID.test(tail[1]) && logicalPath(tail[2])
  return tail[0] === "alias" && tail.length === 3 && one(tail[1], ["redirect_exact", "redirect_prefix"]) && isValidAliasPath(tail[2]) && (tail[1] !== "redirect_prefix" || tail[2].endsWith("/"))
}
function ledgerOf(value) {
  const ledger = emptyLedger()
  if (value == null) return ledger
  if (!exact(value, Object.keys(ledger)) || value.version !== 2) return null
  const validators = {
    pages: item => isCatalogueId(item, "pg"), grants: item => isCatalogueId(item, "gr"),
    idempotencyKeys: isPublicationToken, planIds: isPublicationToken,
    inventoryIds: item => typeof item === "string" && item.length > 0 && item.length <= 128,
    selectionIds: item => typeof item === "string" && item.length > 0 && item.length <= 128,
    operationIds: item => typeof item === "string" && item.length > 0 && item.length <= 1024,
  }
  const validKey = (table, key) => {
    let tuple
    try { tuple = JSON.parse(key); if (!Array.isArray(tuple) || stable(tuple) !== key) return false } catch { return false }
    return validLedgerTuple(table, tuple)
  }
  for (const [key, validate] of Object.entries(validators)) {
    if (!record(value[key]) || Object.entries(value[key]).some(([name, item]) => !validKey(key, name) || !validate(item))) return null
    ledger[key] = { ...value[key] }
  }
  for (const key of ["pages", "grants", "idempotencyKeys", "planIds"]) {
    const values = Object.values(ledger[key])
    if (new Set(values).size !== values.length) return null
  }
  const pairs = new Set()
  for (const key of Object.keys(ledger.inventoryIds)) if (Object.hasOwn(ledger.selectionIds, key)) {
    const pair = stable([ledger.inventoryIds[key], ledger.selectionIds[key]])
    if (pairs.has(pair)) return null
    pairs.add(pair)
  }
  const operationsByProposal = new Map()
  for (const [key, id] of Object.entries(ledger.operationIds)) {
    let tuple
    try { tuple = JSON.parse(key) } catch { return null }
    if (!Array.isArray(tuple) || tuple.length < 5) return null
    const proposal = stable(tuple.slice(0, 4)), seen = operationsByProposal.get(proposal) ?? new Set()
    if (seen.has(id)) return null
    seen.add(id); operationsByProposal.set(proposal, seen)
  }
  return ledger
}
function remember(ledger, table, tuple, mint) {
  if (!validLedgerTuple(table, tuple)) throw new Error("invalid_ledger_tuple")
  const map = ledger[table], key = stable(tuple)
  if (!Object.hasOwn(map, key) || typeof map[key] !== "string") Object.defineProperty(map, key, { value: mint(), enumerable: true, writable: true, configurable: true })
  return map[key]
}
function note(code, extra = {}) {
  const row = { code }
  for (const key of ["path", "sourcePageId", "unitId", "basis"]) if (text(extra[key])) row[key] = extra[key]
  if (extra.budget) row.budget = extra.budget
  return row
}
function validPath(path, allowReserved = false) {
  return typeof path === "string" && path.length >= 2 && path.length <= 1024 && path.startsWith("/") && !path.endsWith("/") &&
    !path.includes("\\") && !path.includes("//") && !path.split("/").some(part => part === "." || part === "..") &&
    !/[\u0000-\u001f\u007f?#]/.test(path) && !/%(?:2f|2e|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path) &&
    (allowReserved || (!/^\/(?:s|_revisions|api|registry)(?:\/|$)/.test(path) && !path.startsWith("/_derived/") &&
    path !== "/manifest.json" && path !== "/asset-owners.json"))
}
function logicalPath(path, allowReserved = false) { return isUnicodeScalarString(path) && validPath(path, allowReserved) }
function slugOf(path) {
  return subtreeSlugOf(path)
}
const documentRoute = documentRouteOf
function routeOf(path) {
  const route = documentRoute(path)
  return route ? route.kind === "subtree" ? `/a/${route.slug}/` : `/${route.pageRef}` : null
}
function shellPath(path, declared, resulting = new Set()) {
  const slug = subtreeSlugOf(path)
  return slug !== null ? !resulting.has(slug) : isReservedShellPath(path) || declared.has(path)
}
export function isProtectedCaptureRelative(value) {
  return typeof value === "string" && value.split("/").some(part => part === ".env" || part.startsWith(".env.") || part === ".git" || part === ".ssh")
}
function safeRelative(value) {
  return isUnicodeScalarString(value) && !!value && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some(part => !part || part === "." || part === "..")
}
function observationOf(observations, path) {
  if (!record(observations) || !Object.hasOwn(observations, path)) return { state: "unknown" }
  const value = observations[path]
  if (!record(value) || !one(value.state, ["present", "absent", "unreadable", "unknown", "changed", "size_mismatch"])) return null
  if (value.state !== "present") return exact(value, ["state"]) ? { state: value.state } : null
  return exact(value, ["state", "size", "sha256"]) && integer(value.size) && value.size >= 0 && hex(value.sha256) ? value : null
}
function capture(value, kind) {
  if (!record(value) || !one(value.state, ["present", "absent", "unreadable", "unknown"])) return null
  if (kind === "share") {
    if (value.state !== "present") return exact(value, ["state"]) ? { state: value.state } : null
    return exact(value, ["state", "key", "expiresAt"]) && (value.key === null || typeof value.key === "string") && (value.expiresAt === null || integer(value.expiresAt)) ? value : null
  }
  if (value.state !== "present") return exact(value, ["state"]) ? { state: value.state } : null
  return exact(value, ["state", "value", "metadataV", "expiresAt"]) && (value.value === null || typeof value.value === "string") && (value.metadataV === null || typeof value.metadataV === "string") && (value.expiresAt === null || integer(value.expiresAt)) ? value : null
}
function header(input) {
  const keys = ["version", "kind", "sourceInstance", "selectionRef", "approvalRef", "g1bRef", "capturedAt", "corpusDigest", "selectionDigest", "mappingRef", "complete", "targetBasis", "limits", "reader", "captureRoots", "entries", "pages", "owners", "aliases", "shortlinks", "previews", "consumerUrls", "exclusions", "providerMounts"]
  if (!exact(input, keys) || input.version !== 1 || !one(input.kind, ["synthetic", "historical"]) || !text(input.sourceInstance) || !text(input.selectionRef) || !text(input.approvalRef) || !integer(input.capturedAt) || input.capturedAt < 0 || !hex(input.corpusDigest) || !hex(input.selectionDigest) || !text(input.mappingRef) || input.complete !== true || !one(input.targetBasis, ["empty", "unknown"])) return "invalid_selection"
  if (input.kind === "historical" ? !text(input.g1bRef) : input.g1bRef !== null) return "g1b_evidence_required"
  const limits = input.limits
  if (!exact(limits, ["maxCommandBytes", "maxJsonDepth", "maxUploadBytes", "maxInventoryBytes"]) || [limits.maxCommandBytes, limits.maxUploadBytes, limits.maxInventoryBytes].some(item => !integer(item) || item <= 0) || !integer(limits.maxJsonDepth) || limits.maxJsonDepth < 1 || limits.maxJsonDepth > 64) return "invalid_limits"
  if (!exact(input.reader, ["canonicalHost", "aliasHosts", "routeGrammars", "shareGrammars", "shareCookie", "shellPaths"]) || !validateReaderProfile(input.reader).ok) return "invalid_grammar"
  if (["captureRoots", "entries", "pages", "owners", "aliases", "shortlinks", "previews", "consumerUrls", "exclusions", "providerMounts"].some(key => !Array.isArray(input[key]))) return "invalid_selection"
  if (input.captureRoots.some(root => typeof root !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(root)) || new Set(input.captureRoots).size !== input.captureRoots.length) return "invalid_capture_root"
  return null
}
async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
}
function parsedConsumer(url, reader) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null
    return parseRequest(new Request(parsed.href), reader).parsed
  } catch { return null }
}
function winningResource(parsed, page, entries, ownersByPath, previewByPage) {
  const expected = documentRoute(page.documentPath)
  const matches = route => expected && route.kind === expected.kind && (route.kind === "subtree" ? route.slug === expected.slug : route.pageRef === expected.pageRef)
  const selected = path => {
    const entry = entries.get(path)
    if (entry?.placement?.sourceArtifactId !== page.membership.sourceArtifactId) return false
    if (path === page.documentPath) return true
    if (expected?.kind === "subtree") return path.startsWith(`/a/${expected.slug}/`)
    return (ownersByPath.get(path) ?? []).some(owner => owner.ownerSourcePageId === page.sourcePageId)
  }
  let path = null
  if (parsed?.kind === "share" && matches(parsed.route)) path = parsed.candidates.find(selected)
  else if (parsed?.kind === "card" && parsed.targets.length === 1 && matches(parsed.targets[0].route)) {
    const eligible = candidate => selected(candidate) && ["image/jpeg", "image/png"].includes(entries.get(candidate)?.contentType)
    const explicit = previewByPage.get(page.sourcePageId)
    const winning = explicit && eligible(explicit) ? explicit : orderedOriginalImageCandidatePaths(expected).find(eligible)
    if (winning === parsed.targets[0].path) path = winning
  } else if (parsed?.kind === "subtree" && expected?.kind === "subtree" && parsed.slug === expected.slug) path = parsed.candidates.find(selected)
  else if (parsed?.kind === "tree" && expected?.kind === "tree_page" && parsed.pageRef === expected.pageRef) path = parsed.candidates.find(selected)
  return path ? { path, kind: entries.get(path).graphClass, governingPage: page.sourcePageId } : null
}
function targetMatches(parsed, page, entries, ownersByPath, previewByPage, purpose = null) {
  const winner = winningResource(parsed, page, entries, ownersByPath, previewByPage)
  return !!winner && (purpose !== "document" || ["page_document", "subdocument"].includes(winner.kind)) &&
    (!(parsed.kind === "share" || parsed.kind === "card") || (page.visibility.state === "present" && page.visibility.value === "shared" && page.share.state === "present" && parsed.key === page.share.key))
}
function validProviderMount(mount) {
  return exact(mount, ["artifactId", "path", "kind"]) && isCatalogueId(mount.artifactId, "ar") && logicalPath(mount.path) && one(mount.kind, ["fragment", "asset"])
}
function budget(selection, inventoryBytes, limits) {
  const command = selection.command
  const envelope = { op: "dry_run", selection, cursor: "x".repeat(LIMITS.cursor) }
  const failed = []
  if (command.files.length > LIMITS.files) failed.push("files")
  if (command.pages.length > LIMITS.pages || command.pages.length === 0 || command.pages.every(page => page.disposition === "drop")) failed.push("pages")
  if (command.edges.length > LIMITS.edges) failed.push("edges")
  if (command.files.some(file => file.size > Math.min(limits.maxUploadBytes, LIMITS.fileBytes))) failed.push("file_bytes")
  const commandBytes = utf8(stable(command))
  const envelopeBytes = utf8(stable(envelope))
  if (commandBytes > limits.maxCommandBytes || envelopeBytes > limits.maxCommandBytes) failed.push("command_bytes")
  if (depth(command) > limits.maxJsonDepth || depth(envelope) > limits.maxJsonDepth) failed.push("json_depth")
  if (inventoryBytes > limits.maxInventoryBytes) failed.push("inventory_bytes")
  return { files: command.files.length, pages: command.pages.length, edges: command.edges.length, largestFile: command.files.reduce((max, file) => Math.max(max, file.size), 0), commandBytes, envelopeBytes, inventoryBytes, failed }
}
const EVIDENCE_COLLECTIONS = [["entry", "entries"], ["page", "pages"], ["owner", "owners"], ["alias", "aliases"], ["shortlink", "shortlinks"], ["preview", "previews"], ["exclusion", "exclusions"], ["providerMount", "providerMounts"], ["consumerUrl", "consumerUrls"]]
function evidenceSlots(input) {
  const slots = new Map()
  for (const [kind, key] of EVIDENCE_COLLECTIONS) {
    const rows = Array.isArray(input?.[key]) ? input[key] : []
    slots.set(kind, rows.map((row, ordinal) => {
      const base = { kind, ordinal, unitIds: [], disposition: "rejected" }
      if (kind !== "providerMount") return base
      const path = typeof row?.path === "string" ? row.path : null
      const providerKind = one(row?.kind, ["fragment", "asset"]) ? row.kind : null
      const declaredProviderArtifactId = isCatalogueId(row?.artifactId, "ar") ? row.artifactId : null
      return { ...base, path, providerKind, declaredProviderArtifactId, reason: validProviderMount(row) ? "provider_mount_unverified" : "invalid_provider_mount" }
    }))
  }
  return slots
}
function censusOf(facts, fatal = false) {
  return facts.map(fact => ({
    kind: fact.kind, ordinal: fact.ordinal, unitId: fact.unitIds.length === 1 ? fact.unitIds[0] : null,
    affectedUnitIds: fact.unitIds, disposition: fatal ? "rejected" : fact.disposition,
    ...(fact.kind === "providerMount" ? { path: fact.path, providerKind: fact.providerKind, declaredProviderArtifactId: fact.declaredProviderArtifactId, reason: fact.reason } : {}),
  }))
}
function allSlots(slots) { return EVIDENCE_COLLECTIONS.flatMap(([kind]) => slots.get(kind)) }


export async function preflightSelection(input, ledgerInput = null) {
  const compatibility = { represented: [], unsupported: [], notObserved: [] }
  const warnings = []
  const accounting = []
  const seen = new Set()
  const account = (path, disposition, unitId, reason) => {
    if (!path || seen.has(path)) return
    seen.add(path)
    const known = entries.get(path)?.placement?.sourceArtifactId
    accounting.push({ path, disposition, unitId: text(unitId) ? unitId : text(known) ? known : null, reason })
  }
  const ledger = ledgerOf(ledgerInput)
  const slots = evidenceSlots(input)
  const fatalCensus = () => censusOf(allSlots(slots), true)
  try { input = structuredClone(input) } catch {
    return { kind: "fatal", result: { ok: false, fatal: "invalid_selection", schema: SELECTED_IMPORT_SCHEMA, ledger: ledger ?? emptyLedger(), accounting, census: fatalCensus(), units: [], compatibility: { represented: [], unsupported: [note("invalid_selection")], notObserved: [] }, warnings } }
  }
  const fatal = header(input)
  if (fatal || !ledger) {
    return { kind: "fatal", result: { ok: false, fatal: fatal ?? "invalid_ledger", schema: SELECTED_IMPORT_SCHEMA, ledger: ledger ?? emptyLedger(), accounting, census: fatalCensus(), units: [], compatibility: { represented: [], unsupported: [note(fatal ?? "invalid_ledger")], notObserved: [] }, warnings } }
  }
  const roots = new Set(input.captureRoots)
  const shells = new Set(input.reader.shellPaths.filter(path => typeof path === "string"))
  const entries = new Map(), entryOrdinals = new Map()
  let contradictory = false
  for (const [ordinal, entry] of input.entries.entries()) {
    const path = record(entry) && typeof entry.path === "string" ? entry.path : undefined
    const nonContent = one(entry?.graphClass, ["shell", "excluded", "unresolved"])
    const validFingerprint = exact(entry?.expected, ["size", "sha256"]) && integer(entry.expected.size) && entry.expected.size >= 0 && hex(entry.expected.sha256)
    if (!exact(entry, ["path", "graphClass", "locator", "contentType", "provenance", "expected", "placement"]) || !validPath(entry.path, true) || !one(entry.graphClass, ["page_document", "subdocument", "fragment", "asset", "shell", "excluded", "unresolved"]) || !(nonContent ? entry.placement === null : exact(entry.placement, ["sourceArtifactId", "evidenceRef"]) && text(entry.placement.sourceArtifactId) && text(entry.placement.evidenceRef)) || !exact(entry.locator, ["root", "relative"]) || !(validFingerprint || (nonContent && entry.expected === null)) || !text(entry.provenance) || !(entry.contentType === null || text(entry.contentType, 255))) {
      contradictory = true
      compatibility.unsupported.push(note("contradictory_entry", { path }))
      if (path) account(path, "blocked", null, "contradictory_entry")
      continue
    }
    if (entries.has(entry.path)) {
      contradictory = true
      compatibility.unsupported.push(note("duplicate_path", { path: entry.path }))
    }
    if (isProtectedCaptureRelative(entry.locator.relative) && (!roots.has(entry.locator.root) || !safeRelative(entry.locator.relative))) contradictory = true
    entryOrdinals.set(entry.path, ordinal)
    if (!roots.has(entry.locator.root) || !safeRelative(entry.locator.relative)) compatibility.unsupported.push(note("unsafe_locator", { path: entry.path }))
    entries.set(entry.path, entry)
  }
  for (const entry of entries.values()) if (!entry.placement && !logicalPath(entry.path, true)) contradictory = true
  const exclusions = new Map()
  for (const exclusion of input.exclusions) {
    if (!exact(exclusion, ["path", "evidenceRef", "reason"]) || !logicalPath(exclusion.path, true) || !text(exclusion.evidenceRef) || !one(exclusion.reason, ["shell", "engine", "non_content"])) {
      contradictory = true
      compatibility.unsupported.push(note("contradictory_exclusion"))
      continue
    }
    if (exclusions.has(exclusion.path)) contradictory = true
    exclusions.set(exclusion.path, exclusion)
  }
  const pages = []
  for (const page of input.pages) {
    if (!exact(page, ["sourcePageId", "documentPath", "metadata", "ownershipEvidenceRef", "membership", "visibility", "share"]) || !exact(page.membership, ["sourceArtifactId", "evidenceRef"]) || !text(page.membership.sourceArtifactId) || !text(page.membership.evidenceRef) || !text(page.sourcePageId) || !validPath(page.documentPath) || !text(page.ownershipEvidenceRef) || ENGINE_ID.test(page.sourcePageId)) {
      compatibility.unsupported.push(note("contradictory_page"))
      continue
    }
    const visibility = capture(page.visibility, "visibility")
    const share = capture(page.share, "share")
    if (!visibility || !share) {
      compatibility.unsupported.push(note("contradictory_page", { path: page.documentPath, sourcePageId: page.sourcePageId }))
      continue
    }
    pages.push({ ...page, visibility, share })
  }
  const pageBySource = new Map()
  for (const page of pages) {
    if (pageBySource.has(page.sourcePageId)) compatibility.unsupported.push(note("duplicate_page", { sourcePageId: page.sourcePageId }))
    pageBySource.set(page.sourcePageId, page)
  }
  const pageByPath = new Map(pages.map(page => [page.documentPath, page]))
  const relationshipBlocked = new Set()
  const selectedByUnit = new Map()
  for (const page of pages) {
    const unitId = page.membership.sourceArtifactId
    const members = selectedByUnit.get(unitId) ?? []
    members.push(page)
    selectedByUnit.set(unitId, members)
  }
  const pageKey = page => [input.sourceInstance, page.membership.sourceArtifactId, page.sourcePageId]
  const proposalKey = (unitId, ...parts) => [input.sourceInstance, unitId, input.selectionRef, input.selectionDigest, ...parts]
  const mountPaths = new Set(input.providerMounts.filter(record).map(mount => mount.path))
  const ownerUnitsByPath = new Map()
  for (const owner of input.owners) {
    const unitId = pageBySource.get(owner?.ownerSourcePageId)?.membership.sourceArtifactId
    if (!unitId || typeof owner?.path !== "string") continue
    const list = ownerUnitsByPath.get(owner.path) ?? new Set()
    list.add(unitId); ownerUnitsByPath.set(owner.path, list)
  }
  const mappings = new Map(), unions = new Map()
  for (const mapping of input.shortlinks) if (text(mapping?.mappingId)) {
    const summary = mappings.get(mapping.mappingId) ?? { count: 0, sole: null, page: null, units: new Set() }
    summary.count++
    const page = pageBySource.get(mapping.targetSourcePageId)
    if (page) summary.units.add(page.membership.sourceArtifactId)
    summary.sole = summary.count === 1 ? mapping : null
    summary.page = summary.count === 1 ? page : null
    mappings.set(mapping.mappingId, summary)
  }
  const consumerResolutions = input.consumerUrls.map(row => {
    const summary = typeof row?.mappingRef === "string" ? mappings.get(row.mappingRef) : null
    const directPage = typeof row?.targetSourcePageId === "string" ? pageBySource.get(row.targetSourcePageId) : null
    const directUnit = directPage?.membership.sourceArtifactId
    const key = stable([typeof row?.mappingRef === "string" ? row.mappingRef : null, directUnit ?? null])
    if (!unions.has(key)) unions.set(key, [...new Set([...(summary?.units ?? []), directUnit].filter(value => text(value)))])
    return { summary, directPage, unitIds: unions.get(key) }
  })
  for (const [kind, key] of EVIDENCE_COLLECTIONS) for (let ordinal = 0; ordinal < input[key].length; ordinal++) {
    const row = input[key][ordinal], slot = slots.get(kind)[ordinal]
    if (kind === "consumerUrl") { slot.unitIds = consumerResolutions[ordinal].unitIds; continue }
    if (kind === "providerMount") {
      if (typeof row?.path !== "string") continue
      const localUnit = entries.get(row.path)?.placement?.sourceArtifactId
      slot.unitIds = [...new Set([...(ownerUnitsByPath.get(row.path) ?? []), localUnit].filter(Boolean))]
      if (localUnit) slot.reason = "provider_local_placement_conflict"
      continue
    }
    const sourceKey = kind === "owner" ? row?.ownerSourcePageId : kind === "preview" ? row?.sourcePageId : row?.targetSourcePageId
    const primary = kind === "entry" ? row?.placement?.sourceArtifactId : kind === "page" ? row?.membership?.sourceArtifactId : kind === "exclusion" ? entries.get(row?.path)?.placement?.sourceArtifactId : pageBySource.get(sourceKey)?.membership.sourceArtifactId
    const secondary = kind === "entry" ? pageByPath.get(row?.path)?.membership.sourceArtifactId : null
    slot.unitIds = [...new Set([primary, secondary].filter(value => text(value)))]
  }
  if (contradictory) {
    for (const path of entries.keys()) account(path, "blocked", null, "contradictory_input")
    return { kind: "fatal", result: { ok: false, fatal: "contradictory_input", schema: SELECTED_IMPORT_SCHEMA, ledger, accounting, census: fatalCensus(), units: [], compatibility, warnings, sourceInstance: input.sourceInstance, kind: input.kind } }
  }
  const relationshipCensus = []
  let unassignable = pages.length !== input.pages.length || pageBySource.size !== pages.length || pageByPath.size !== pages.length
  const relationships = [
    ["owner", input.owners, "ownerSourcePageId", ["path", "ownerSourcePageId", "evidenceRef", "basis"]],
    ["alias", input.aliases, "targetSourcePageId", ["aliasKind", "path", "to", "status", "targetSourcePageId", "capturedBehavior"]],
    ["shortlink", input.shortlinks, "targetSourcePageId", ["mappingId", "providerOrigin", "providerId", "shortDomain", "shortCode", "shortUrl", "targetSourcePageId", "destination", "observedAt"]],
    ["preview", input.previews, "sourcePageId", ["sourcePageId", "path", "kind"]],
  ]
  const relationshipKeys = new Set()
  for (const [kind, rows, sourceKey, keys] of relationships) {
    for (let ordinal = 0; ordinal < rows.length; ordinal++) {
      const row = rows[ordinal]
      const page = record(row) ? pageBySource.get(row[sourceKey]) : null
      const unitId = page?.membership.sourceArtifactId ?? null
      if (!unitId) unassignable = true
      let valid = exact(row, keys)
      if (valid && kind === "owner") valid = logicalPath(row.path, true) && isUnicodeScalarString(row.ownerSourcePageId) && text(row.evidenceRef) && row.basis === "declared" && (["fragment", "asset"].includes(entries.get(row.path)?.graphClass) || mountPaths.has(row.path))
      if (valid && kind === "alias") valid = one(row.aliasKind, ["redirect_exact", "redirect_prefix"]) && isValidAliasPath(row.path) && isValidAliasDestination(row.to) && [301, 302, 307, 308].includes(row.status) && row.capturedBehavior === "team_fallback" && (row.aliasKind !== "redirect_prefix" || row.path.endsWith("/"))
      if (valid && kind === "shortlink") valid = text(row.mappingId) && text(row.providerOrigin) && (row.providerId === null || text(row.providerId)) && text(row.shortDomain) && text(row.shortCode) && text(row.shortUrl) && text(row.destination, 4096) && integer(row.observedAt) && row.observedAt >= 0 && validShortlinkIdentity(row.providerOrigin, row.shortDomain, row.shortCode, row.shortUrl)
      if (valid && kind === "preview") valid = logicalPath(row.path) && one(row.kind, ["original", "derived_only"]) && entries.has(row.path)
      const identity = valid ? kind === "owner" ? stable([kind, row.ownerSourcePageId, row.path]) : stable([kind, row]) : null
      if (identity && relationshipKeys.has(identity)) valid = false
      if (identity) relationshipKeys.add(identity)
      if (!valid) {
        if (unitId) relationshipBlocked.add(unitId)
        compatibility.unsupported.push(note(`invalid_${kind}`, { unitId }))
      }
      relationshipCensus.push({ kind, ordinal, unitId, disposition: valid ? "pending" : "rejected" })
    }
  }
  for (const exclusion of input.exclusions) if (!entries.has(exclusion.path)) unassignable = true
  for (const [ordinal, mount] of input.providerMounts.entries()) {
    const slot = slots.get("providerMount")[ordinal], dependents = slot.unitIds
    if (!dependents.length) unassignable = true
    for (const unitId of dependents) {
      relationshipBlocked.add(unitId)
      compatibility.unsupported.push(note(slot.reason, { unitId, path: mount?.path }))
    }
  }
  if (unassignable) {
    compatibility.unsupported.push(note("unassignable_record"))
    return { kind: "fatal", result: { ok: false, fatal: "unassignable_record", schema: SELECTED_IMPORT_SCHEMA, ledger, accounting, census: fatalCensus(), units: [], compatibility, warnings, sourceInstance: input.sourceInstance, kind: input.kind } }
  }
  const owners = []
  for (const owner of input.owners) {
    if (!exact(owner, ["path", "ownerSourcePageId", "evidenceRef", "basis"]) || !text(owner.path) || !text(owner.ownerSourcePageId) || !text(owner.evidenceRef)) {
      compatibility.unsupported.push(note("contradictory_owner"))
      continue
    }
    if (owner.basis !== "declared") {
      compatibility.unsupported.push(note("basename_heuristic_refused", { path: owner.path }))
      continue
    }
    owners.push(owner)
  }
  const ownersByPath = new Map()
  for (const owner of owners) {
    const list = ownersByPath.get(owner.path) ?? []
    list.push(owner)
    ownersByPath.set(owner.path, list)
  }
  const blockedUnits = new Set(relationshipBlocked)
  for (const page of pages) {
    const unitId = page.membership.sourceArtifactId
    const entry = entries.get(page.documentPath)
    let code = null
    if (!isUnicodeScalarString(page.documentPath) || !isUnicodeScalarString(page.sourcePageId)) code = "invalid_logical_path"
    else if (!entry) code = page.visibility.state === "present" && ["public", "shared"].includes(page.visibility.value) ? "or1_missing_document" : "page_without_document"
    else if (entry.graphClass !== "page_document" || entry.placement?.sourceArtifactId !== unitId) {
      code = "document_placement_conflict"
      if (entry.placement?.sourceArtifactId) blockedUnits.add(entry.placement.sourceArtifactId)
    }
    else if (page.sourcePageId !== (slugOf(page.documentPath) ?? page.documentPath.slice(1))) code = "source_identity_mismatch"
    else if (page.metadata === null) code = "missing_metadata"
    else {
      try { if (stable(page.metadata).length > 8192) code = "metadata_too_large" } catch { code = "metadata_too_large" }
    }
    const visibility = page.visibility, share = page.share
    if (!code && (visibility.state === "unknown" || visibility.state === "unreadable")) code = `visibility_${visibility.state}`
    if (!code && (share.state === "unknown" || share.state === "unreadable")) code = `share_key_${share.state}`
    if (!code && visibility.state === "present" && visibility.value === null) code = "visibility_present_without_value"
    if (!code && share.state === "present" && share.key === null) code = "share_present_without_key"
    if (!code && visibility.state === "present" && visibility.metadataV !== null && visibility.metadataV !== visibility.value) code = "visibility_metadata_mismatch"
    if (!code && visibility.state === "present" && (visibility.expiresAt !== null || (visibility.value === "shared" && share.state === "present" && share.expiresAt !== null))) code = "expiring_policy_unsupported"
    if (!code && visibility.state === "present" && visibility.value === "shared" && (share.state !== "present" || typeof share.key !== "string" || !SHARE_KEY.test(share.key))) code = share.state === "absent" ? "share_key_absent" : "invalid_share_key"
    if (code) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note(code, { path: page.documentPath, sourcePageId: page.sourcePageId, unitId, basis: !entry ? "missing_inventory_entry" : code === "document_placement_conflict" ? "conflicting_placement" : null }))
      if (code === "visibility_unknown" || code === "visibility_unreadable" || code === "share_key_unknown" || code === "share_key_unreadable") compatibility.notObserved.push(note(code, { sourcePageId: page.sourcePageId, unitId }))
    }
    if (!code && visibility.state === "present" && !["private", "public", "shared"].includes(visibility.value)) warnings.push(note("unknown_visibility_private", { sourcePageId: page.sourcePageId, unitId }))
    if (!code && visibility.state === "absent") compatibility.represented.push(note("visibility_absent_private", { sourcePageId: page.sourcePageId, unitId }))
    if (!code && visibility.value !== "shared" && share.state === "present") compatibility.unsupported.push(note("share_key_not_imported", { sourcePageId: page.sourcePageId, unitId }))
  }
  for (const entry of entries.values()) if (entry.placement && !selectedByUnit.has(entry.placement.sourceArtifactId)) {
    const unitId = entry.placement.sourceArtifactId
    selectedByUnit.set(unitId, [])
    blockedUnits.add(unitId)
    compatibility.unsupported.push(note("placement_without_membership", { path: entry.path, unitId }))
  }
  if (input.targetBasis !== "empty") for (const unitId of selectedByUnit.keys()) {
    blockedUnits.add(unitId)
    compatibility.unsupported.push(note("target_basis_unknown", { unitId }))
  }
  const subtreesByUnit = new Map()
  for (const [unitId, members] of selectedByUnit) subtreesByUnit.set(unitId, new Set(members.map(page => documentRoute(page.documentPath)).filter(route => route?.kind === "subtree").map(route => route.slug)))
  for (const entry of entries.values()) {
    if (!entry.placement) continue
    let code = null
    if (!isUnicodeScalarString(entry.path)) code = "invalid_logical_path"
    else if (!roots.has(entry.locator.root) || !safeRelative(entry.locator.relative) || isProtectedCaptureRelative(entry.locator.relative)) code = "unsafe_locator"
    else if (exclusions.has(entry.path)) code = "excluded_content_contradiction"
    else if (entry.graphClass === "fragment" && !(ownersByPath.get(entry.path)?.length)) code = "fragment_without_owner"
    else if (entry.contentType === null || !MIME.test(entry.contentType) || (entry.graphClass === "asset" && entry.path.endsWith(".html")) || (entry.graphClass === "page_document" && (!documentRoute(entry.path) || entry.contentType !== "text/html")) || (entry.graphClass === "subdocument" && (entry.contentType !== "text/html" || !entry.path.endsWith(".html"))) || (entry.graphClass === "fragment" && entry.contentType !== "text/html")) code = "contradictory_class"
    else if (entry.graphClass === "subdocument" && ![...(subtreesByUnit.get(entry.placement.sourceArtifactId) ?? [])].some(slug => entry.path.startsWith(`/a/${slug}/`))) code = "subdocument_without_subtree"
    else if ((ownersByPath.get(entry.path)?.length ?? 0) > LIMITS.owners) code = "uncapped_owners"
    else if (entry.expected.size > Math.min(input.limits.maxUploadBytes, LIMITS.fileBytes)) code = "file_bytes"
    if (code) {
      blockedUnits.add(entry.placement.sourceArtifactId)
      compatibility.unsupported.push(note(code, { path: entry.path, unitId: entry.placement.sourceArtifactId }))
    }
  }
  const staticEntries = new Map()
  for (const entry of entries.values()) if (entry.placement) {
    const unitId = entry.placement.sourceArtifactId
    const list = staticEntries.get(unitId) ?? []; list.push(entry); staticEntries.set(unitId, list)
    const resulting = subtreesByUnit.get(unitId) ?? new Set()
    if (shellPath(entry.path, shells, resulting)) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("reserved_path", { path: entry.path, unitId }))
    }
  }
  const assessedMountsByPath = new Map()
  for (const slot of slots.get("providerMount")) if (slot.path !== null) {
    const list = assessedMountsByPath.get(slot.path) ?? []
    list.push(slot); assessedMountsByPath.set(slot.path, list)
  }
  const dependenciesByUnit = new Map()
  const dependencyKeysByUnit = new Map()
  for (const owner of owners) {
    const unitId = pageBySource.get(owner.ownerSourcePageId)?.membership.sourceArtifactId
    if (!unitId || entries.get(owner.path)?.placement?.sourceArtifactId === unitId) continue
    const mounts = assessedMountsByPath.get(owner.path) ?? []
    const localKind = entries.get(owner.path)?.graphClass
    const dependencies = mounts.length
      ? mounts.map(mount => ({ path: owner.path, providerArtifactId: mount.reason === "provider_mount_unverified" ? mount.declaredProviderArtifactId : null, kind: mount.providerKind, state: mount.reason === "provider_mount_unverified" ? "unverified" : "missing" }))
      : [{ path: owner.path, providerArtifactId: null, kind: one(localKind, ["fragment", "asset"]) ? localKind : null, state: "missing" }]
    const list = dependenciesByUnit.get(unitId) ?? [], keys = dependencyKeysByUnit.get(unitId) ?? new Set()
    for (const dependency of dependencies) if (!keys.has(stable(dependency))) {
      keys.add(stable(dependency)); list.push(dependency)
    }
    dependenciesByUnit.set(unitId, list); dependencyKeysByUnit.set(unitId, keys)
  }
  for (const owner of owners) {
    const page = pageBySource.get(owner.ownerSourcePageId)
    if (!page) continue
    const unitId = page.membership.sourceArtifactId
    if (entries.get(owner.path)?.placement?.sourceArtifactId !== unitId) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("provider_mount_required", { path: owner.path, unitId }))
    }
  }
  for (const preview of input.previews) {
    const page = pageBySource.get(preview?.sourcePageId)
    if (!page) continue
    const unitId = page.membership.sourceArtifactId
    if (preview.kind !== "original") {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("derived_preview_unsupported", { path: preview.path, sourcePageId: page.sourcePageId, unitId }))
      continue
    }
  }
  const previewByPage = new Map(input.previews.filter(row => row?.kind === "original").map(row => [row.sourcePageId, row.path]))
  const policyOperations = new Map(), relationshipOperations = new Map(), proposed = [], proposedUnits = []
  const addProposal = (operation, unitId) => { proposed.push(operation); proposedUnits.push(unitId) }
  for (const page of pages) {
    const unitId = page.membership.sourceArtifactId
    if (blockedUnits.has(unitId)) continue
    const pageId = remember(ledger, "pages", pageKey(page), () => engineId("pg"))
    const visibilityValue = page.visibility.state === "present" ? page.visibility.value : null
    const shareKey = page.share.state === "present" ? page.share.key : null
    const grantId = visibilityValue === "shared" ? remember(ledger, "grants", pageKey(page), () => engineId("gr")) : null
    const operation = { kind: "page_policy", policy: { operationId: remember(ledger, "operationIds", proposalKey(unitId, "policy", page.sourcePageId), () => `op${opaque()}`), sourcePageId: page.sourcePageId, pageId, expectedPolicyEpoch: null, grantId, visibility: { captured: true, value: visibilityValue, metadataV: page.visibility.state === "present" ? page.visibility.metadataV : null, expiresAt: null }, share: { captured: true, key: shareKey, expiresAt: page.share.state === "present" ? page.share.expiresAt : null } } }
    policyOperations.set(page.sourcePageId, operation)
    addProposal(operation, unitId)
  }
  for (const alias of input.aliases) {
    const page = pageBySource.get(alias?.targetSourcePageId), unitId = page?.membership.sourceArtifactId
    if (!page || blockedUnits.has(unitId) || !exact(alias, ["aliasKind", "path", "to", "status", "targetSourcePageId", "capturedBehavior"]) || !one(alias.aliasKind, ["redirect_exact", "redirect_prefix"]) || !isValidAliasPath(alias.path) || !isValidAliasDestination(alias.to) || ![301, 302, 307, 308].includes(alias.status) || alias.capturedBehavior !== "team_fallback") continue
    const operation = { kind: "alias", operationId: remember(ledger, "operationIds", proposalKey(unitId, "alias", alias.aliasKind, alias.path), () => `op${opaque()}`), aliasKind: alias.aliasKind, path: alias.path, to: alias.to, status: alias.status, targetPageId: policyOperations.get(page.sourcePageId).policy.pageId }
    relationshipOperations.set(alias, operation); addProposal(operation, unitId)
  }
  for (const link of input.shortlinks) {
    const page = pageBySource.get(link?.targetSourcePageId), unitId = page?.membership.sourceArtifactId
    if (!page || blockedUnits.has(unitId) || !exact(link, ["mappingId", "providerOrigin", "providerId", "shortDomain", "shortCode", "shortUrl", "targetSourcePageId", "destination", "observedAt"]) || !text(link.mappingId) || !text(link.destination, 4096) || !integer(link.observedAt) || link.observedAt < 0 || !validShortlinkIdentity(link.providerOrigin, link.shortDomain, link.shortCode, link.shortUrl)) continue
    const policy = policyOperations.get(page.sourcePageId).policy
    const parsed = parsedConsumer(link.destination, input.reader)
    const keyed = parsed?.kind === "share" || parsed?.kind === "card"
    const validTarget = parsed && targetMatches(parsed, page, entries, ownersByPath, previewByPage)
    const grantId = validTarget && keyed ? policy.grantId : null
    if (!validTarget || (keyed && !grantId)) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("shortlink_destination_unverified", { sourcePageId: page.sourcePageId, unitId }))
      continue
    }
    const operation = { kind: "shortlink", operationId: remember(ledger, "operationIds", proposalKey(unitId, "shortlink", link.mappingId), () => `op${opaque()}`), mapping: { mappingId: link.mappingId, providerOrigin: link.providerOrigin, providerId: link.providerId, shortDomain: link.shortDomain, shortCode: link.shortCode, shortUrl: link.shortUrl, pageId: policy.pageId, grantId, destination: link.destination, source: "imported", observedAt: link.observedAt, destinationDigest: await digest(link.destination) } }
    relationshipOperations.set(link, operation); addProposal(operation, unitId)
  }
  for (const preview of input.previews) {
    const page = pageBySource.get(preview?.sourcePageId), unitId = page?.membership.sourceArtifactId
    if (!page || blockedUnits.has(unitId) || preview.kind !== "original" || !logicalPath(preview.path)) continue
    const operation = { kind: "preview_selection", operationId: remember(ledger, "operationIds", proposalKey(unitId, "preview", preview.sourcePageId, preview.path), () => `op${opaque()}`), pageId: policyOperations.get(page.sourcePageId).policy.pageId, path: preview.path }
    relationshipOperations.set(preview, operation); addProposal(operation, unitId)
  }
  for (const index of conflictingImportOperationIndexes(proposed)) {
    const unitId = proposedUnits[index]
    blockedUnits.add(unitId)
    if (!compatibility.unsupported.some(issue => issue.code === "conflicting_import_operations" && issue.unitId === unitId)) compatibility.unsupported.push(note("conflicting_import_operations", { unitId }))
  }
  const knownBudgets = new Map()
  for (const [unitId, members] of selectedByUnit) {
    const sourceEntries = staticEntries.get(unitId) ?? []
    const largestFile = sourceEntries.reduce((max, entry) => Math.max(max, entry.expected.size), 0)
    const counts = { files: sourceEntries.length, pages: members.length, edges: 0, largestFile, commandBytes: null, envelopeBytes: null, inventoryBytes: null, failed: [] }
    knownBudgets.set(unitId, counts)
  }
  for (const owner of owners) {
    const unitId = pageBySource.get(owner.ownerSourcePageId)?.membership.sourceArtifactId
    if (knownBudgets.has(unitId)) knownBudgets.get(unitId).edges++
  }
  for (const [unitId, counts] of knownBudgets) {
    if (counts.files > LIMITS.files) counts.failed.push("files")
    if (!counts.pages || counts.pages > LIMITS.pages) counts.failed.push("pages")
    if (counts.edges > LIMITS.edges) counts.failed.push("edges")
    if (counts.largestFile > Math.min(input.limits.maxUploadBytes, LIMITS.fileBytes)) counts.failed.push("file_bytes")
    if (counts.failed.length) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("budget_exceeded", { unitId, budget: counts }))
    }
  }
  const staticEdges = new Map(), staticOperations = new Map(), compiled = new Map()
  for (const [path, list] of ownersByPath) for (const owner of list) {
    const unitId = pageBySource.get(owner.ownerSourcePageId)?.membership.sourceArtifactId
    if (!unitId) continue
    const rows = staticEdges.get(unitId) ?? []
    rows.push({ ownerPageId: ledger.pages[stable(pageKey(pageBySource.get(owner.ownerSourcePageId)))], path, providerArtifactId: null, evidenceRef: owner.evidenceRef })
    staticEdges.set(unitId, rows)
  }
  for (let index = 0; index < proposed.length; index++) {
    const unitId = proposedUnits[index], rows = staticOperations.get(unitId) ?? []
    rows.push(proposed[index]); staticOperations.set(unitId, rows)
  }
  const namespaces = new Map()
  for (const unitId of selectedByUnit.keys()) if (!blockedUnits.has(unitId)) {
    namespaces.set(unitId, await digest(stable(["forge-offline-source-v1", input.sourceInstance, unitId, input.selectionRef, input.selectionDigest])))
  }
  for (const [unitId, members] of selectedByUnit) {
    if (blockedUnits.has(unitId)) continue
    const sourceEntries = (staticEntries.get(unitId) ?? []).slice().sort((a, b) => a.path < b.path ? -1 : 1)
    const files = sourceEntries.map(entry => ({ path: entry.path, kind: entry.graphClass === "page_document" ? "document" : entry.graphClass, sha256: entry.expected.sha256, size: entry.expected.size, contentType: entry.contentType, source: "client" }))
    const pagesOut = members.map(page => ({ pageId: policyOperations.get(page.sourcePageId).policy.pageId, disposition: "new", documentPath: page.documentPath, metadata: page.metadata, expectedPolicyEpoch: null })).sort((a, b) => a.pageId < b.pageId ? -1 : 1)
    const edges = staticEdges.get(unitId) ?? []
    const key = proposalKey(unitId)
    const command = { idempotencyKey: remember(ledger, "idempotencyKeys", key, () => `k${opaque()}`), artifactId: null, expectedRevisionId: null, expectedContentVersion: 0, files, pages: pagesOut, edges: edges.map(({ evidenceRef: _evidence, ...edge }) => edge) }
    const inventoryId = remember(ledger, "inventoryIds", key, () => `inv${opaque()}`)
    const selectionId = remember(ledger, "selectionIds", key, () => `sel${opaque()}`)
    const selection = { version: 1, inventoryId, selectionId, planId: remember(ledger, "planIds", key, () => `plan${opaque()}`), command }
    const inventory = { version: 1, inventoryId, selectionId, sourceInstance: input.sourceInstance, sourceArtifactId: unitId, approvalRef: input.approvalRef, kind: input.kind, command,
      pageMappings: members.map(page => ({ sourcePageId: page.sourcePageId, pageId: policyOperations.get(page.sourcePageId).policy.pageId, documentPath: page.documentPath, route: routeOf(page.documentPath), ownershipEvidenceRef: page.ownershipEvidenceRef })).sort((a, b) => a.pageId < b.pageId ? -1 : 1),
      edgeEvidence: edges, evidence: { selectionDigest: input.selectionDigest, corpusDigest: input.corpusDigest, mappingRef: input.mappingRef, capturedAt: input.capturedAt, complete: true, g1bRef: input.g1bRef },
      files: sourceEntries.map(entry => ({ path: entry.path, kind: entry.graphClass === "page_document" ? "document" : entry.graphClass, contentType: entry.contentType, size: entry.expected.size, sha256: entry.expected.sha256, sourceRef: `capture/v1/${namespaces.get(unitId)}/${entryOrdinals.get(entry.path)}`, sourceVersion: null, provenance: entry.provenance })), operations: staticOperations.get(unitId) ?? [] }
    try { validateBeginCommand(command) } catch {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("invalid_begin_command", { unitId }))
    }
    for (const operation of inventory.operations) if (operation.kind === "preview_selection" && !importPreviewOwned(command, operation.pageId, operation.path)) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("preview_not_owned", { unitId, path: operation.path }))
    }
    const cost = budget(selection, utf8(stable(inventory)), input.limits)
    if (cost.failed.length) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("budget_exceeded", { unitId, budget: cost }))
    }
    compiled.set(unitId, { command, selection, inventory, cost })
  }
  const aliasExact = new Map(), aliasPrefix = new Map(), mountedResources = new Set()
  const selectedSubtreeSlugs = new Set(), selectedTreePages = new Set()
  for (const [unitId, draft] of compiled) {
    if (blockedUnits.has(unitId)) continue
    for (const page of selectedByUnit.get(unitId)) {
      const route = documentRoute(page.documentPath)
      if (route?.kind === "subtree") selectedSubtreeSlugs.add(route.slug)
      else if (route?.kind === "tree_page") selectedTreePages.add(route.pageRef)
    }
    for (const file of draft.command.files) if (one(file.kind, ["fragment", "asset"])) mountedResources.add(file.path)
  }
  for (const [alias, operation] of relationshipOperations) {
    if (operation.kind !== "alias") continue
    const unitId = pageBySource.get(alias.targetSourcePageId)?.membership.sourceArtifactId
    if (!compiled.has(unitId) || blockedUnits.has(unitId)) continue
    const index = alias.aliasKind === "redirect_exact" ? aliasExact : aliasPrefix
    if (!index.has(alias.path)) index.set(alias.path, alias)
  }
  const consumerChecks = []
  for (let ordinal = 0; ordinal < input.consumerUrls.length; ordinal++) {
    const row = input.consumerUrls[ordinal]
    const { summary, directPage, unitIds } = consumerResolutions[ordinal]
    const mapping = summary?.sole ?? null
    const mappedPage = summary?.page ?? null
    const page = directPage ?? mappedPage
    if (!page) {
      if (!unitIds.length) unassignable = true
      else {
        for (const affected of unitIds) { blockedUnits.add(affected); compatibility.unsupported.push(note("consumer_url_unsupported", { unitId: affected })) }
        consumerChecks.push({ ordinal, page: null, unitId: null, unitIds, valid: false, code: "consumer_url_unsupported" })
      }
      continue
    }
    const unitId = page.membership.sourceArtifactId
    const referencesValid = (row.targetSourcePageId === null || !!directPage) && (row.mappingRef === null || !!mapping) && (!directPage || !mappedPage || directPage === mappedPage)
    let valid = referencesValid && exact(row, ["url", "purpose", "targetSourcePageId", "mappingRef"]) && typeof row.url === "string" && one(row.purpose, ["share", "card", "alias", "shortlink", "document"])
    const parsed = valid ? parsedConsumer(row.url, input.reader) : null
    if (valid && row.purpose === "shortlink") {
      const destination = mapping && parsedConsumer(mapping.destination, input.reader)
      valid = !!mapping && mapping.shortUrl === row.url && !!destination && targetMatches(destination, page, entries, ownersByPath, previewByPage)
    }
    else if (valid && row.purpose === "alias") {
      try {
        const url = new URL(row.url)
        if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid_consumer")
        const result = parseRequest(new Request(url.href), input.reader)
        const path = result.aliasPath
        const primary = result.parsed.kind === "tree" ? selectedTreePages.has(result.parsed.pageRef) || mountedResources.has(`/${result.parsed.pageRef}`) : result.parsed.kind === "subtree" ? selectedSubtreeSlugs.has(result.parsed.slug) : result.parsed.kind === "resource" && mountedResources.has(result.parsed.path)
        let alias = path && !primary ? aliasExact.get(path) : null
        if (!alias && path && !primary) {
          let prefix = path
          while (prefix.includes("/")) {
            prefix = prefix.slice(0, prefix.lastIndexOf("/") + 1)
            if (aliasPrefix.has(prefix)) { alias = aliasPrefix.get(prefix); break }
            if (prefix === "/") break
            prefix = prefix.slice(0, -1)
          }
        }
        valid = !!alias && alias.targetSourcePageId === page.sourcePageId && aliasMatchesPath(alias.aliasKind, alias.path, path)
        if (valid) {
          const location = aliasLocation(alias.aliasKind, alias.path, alias.to, path)
          const destination = parsedConsumer(new URL(location, url.origin).href, input.reader)
          valid = !!destination && targetMatches(destination, page, entries, ownersByPath, previewByPage, "document")
        }
      } catch { valid = false }
    } else if (valid) {
      const kindMatches = row.purpose === "share" ? parsed?.kind === "share" : row.purpose === "card" ? parsed?.kind === "card" : parsed?.kind === "tree" || parsed?.kind === "subtree"
      valid = !!parsed && kindMatches && targetMatches(parsed, page, entries, ownersByPath, previewByPage, row.purpose === "document" ? "document" : null)
    }
    const code = parsed?.kind === "card" && parsed.targets.length > 1 ? "two_candidate_card" : "consumer_url_unsupported"
    if (!valid) for (const affected of unitIds) {
      blockedUnits.add(affected)
      compatibility.unsupported.push(note(code, { unitId: affected }))
    }
    consumerChecks.push({ ordinal, page, unitId, unitIds, valid: !!valid, code })
  }
  if (unassignable) {
    compatibility.unsupported.push(note("unassignable_record"))
    return { kind: "fatal", result: { ok: false, fatal: "unassignable_record", schema: SELECTED_IMPORT_SCHEMA, ledger, accounting, census: fatalCensus(), units: [], compatibility, warnings, sourceInstance: input.sourceInstance, kind: input.kind } }
  }
  const issuesByUnit = new Map()
  for (const issue of compatibility.unsupported) if (issue.unitId) {
    const list = issuesByUnit.get(issue.unitId) ?? []
    list.push(issue); issuesByUnit.set(issue.unitId, list)
  }
  const units = [...selectedByUnit].map(([unitId, members]) => {
    const draft = compiled.get(unitId), unitEntries = staticEntries.get(unitId) ?? []
    const blocked = blockedUnits.has(unitId) || !draft
    return {
      unitId, status: blocked ? "blocked" : "representable", pinState: blocked ? "blocked" : "awaiting_source",
      blockers: issuesByUnit.get(unitId) ?? [],
      budget: draft?.cost ?? knownBudgets.get(unitId),
      dependencies: dependenciesByUnit.get(unitId) ?? [],
      sourceEvidence: { membership: members.map(page => ({ sourcePageId: page.sourcePageId, evidenceRef: page.membership.evidenceRef })), placement: unitEntries.map(entry => ({ path: entry.path, evidenceRef: entry.placement.evidenceRef })) },
      command: blocked ? null : draft.command, selection: blocked ? null : draft.selection, inventory: blocked ? null : draft.inventory,
      sourceArtifactId: unitId, maxInventoryBytes: input.limits.maxInventoryBytes, inventoryKey: blocked ? null : `inventory/v1/${namespaces.get(unitId)}.json`,
    }
  }).sort((a, b) => a.unitId < b.unitId ? -1 : 1)
  const facts = []
  const rowFact = (kind, ordinal, unitIds, disposition, extra = {}) => {
    const slot = slots.get(kind)[ordinal]
    slot.disposition = disposition
    if (kind === "entry") {
      slot.path = extra.path; slot.locator = extra.locator; slot.unitId = extra.unitId
      slot.sourcePageId = extra.sourcePageId; slot.publicOrSharedDocument = extra.publicOrSharedDocument
      slot.reason = extra.reason; slot.readCohort = extra.readCohort
    } else if (kind === "page" && typeof extra.missingPath === "string") slot.missingPath = extra.missingPath
    facts.push(slot)
  }
  const reads = [], protectedLocators = []
  for (let ordinal = 0; ordinal < input.entries.length; ordinal++) {
    const entry = input.entries[ordinal], unitId = entry.placement?.sourceArtifactId ?? null
    const resulting = subtreesByUnit.get(unitId) ?? new Set()
    const protectedPath = isProtectedCaptureRelative(entry.locator.relative) || exclusions.has(entry.path) || entry.graphClass === "shell" || entry.graphClass === "excluded" || (subtreeSlugOf(entry.path) === null && shellPath(entry.path, shells, resulting))
    const excluded = !entry.placement && protectedPath && exclusions.has(entry.path)
    const disposition = excluded ? "excluded" : !entry.placement || blockedUnits.has(unitId) || protectedPath ? "rejected" : "represented"
    const sourcePage = pageByPath.get(entry.path)
    const publicOrSharedDocument = !!sourcePage && entry.graphClass === "page_document" && sourcePage.membership.sourceArtifactId === unitId && sourcePage.visibility.state === "present" && ["public", "shared"].includes(sourcePage.visibility.value)
    rowFact("entry", ordinal, [unitId, sourcePage?.membership.sourceArtifactId], disposition, { path: entry.path, locator: { root: entry.locator.root, relative: entry.locator.relative }, unitId, sourcePageId: sourcePage?.sourcePageId ?? null, publicOrSharedDocument, readCohort: protectedPath ? "protected" : disposition === "represented" ? "candidate" : "omitted", reason: excluded ? exclusions.get(entry.path).reason : disposition === "represented" ? "representable" : !entry.placement ? entry.graphClass === "unresolved" ? "unresolved_path" : "exclusion_evidence_required" : "preflight_blocked" })
    if (protectedPath) protectedLocators.push({ ordinal, locator: entry.locator })
    else if (disposition === "represented") reads.push({ ordinal, path: entry.path, locator: entry.locator, expected: entry.expected, sourceKey: `capture/v1/${namespaces.get(unitId)}/${ordinal}`, unitId, sourcePageId: sourcePage?.sourcePageId ?? null, publicDocument: publicOrSharedDocument })
    if (!entry.placement && !excluded) compatibility.unsupported.push(note(entry.graphClass === "unresolved" ? "unresolved_path" : "exclusion_evidence_required", { path: entry.path }))
    if (excluded) compatibility.represented.push(note("excluded", { path: entry.path }))
  }
  for (let ordinal = 0; ordinal < input.pages.length; ordinal++) {
    const page = input.pages[ordinal]
    rowFact("page", ordinal, [page.membership.sourceArtifactId], "represented", entries.has(page.documentPath) ? {} : { missingPath: page.documentPath })
  }
  for (const row of relationshipCensus) rowFact(row.kind, row.ordinal, [row.unitId], row.disposition === "pending" ? "represented" : "rejected")
  for (let ordinal = 0; ordinal < input.exclusions.length; ordinal++) {
    const entry = entries.get(input.exclusions[ordinal].path)
    rowFact("exclusion", ordinal, [entry?.placement?.sourceArtifactId], entry && !entry.placement ? "represented" : "rejected")
  }
  for (let ordinal = 0; ordinal < input.providerMounts.length; ordinal++) {
    rowFact("providerMount", ordinal, slots.get("providerMount")[ordinal].unitIds, "rejected")
  }
  for (const check of consumerChecks) {
    rowFact("consumerUrl", check.ordinal, check.unitIds, check.valid ? "represented" : "rejected")
    if (check.valid) compatibility.represented.push(note("consumer_url_represented", { sourcePageId: check.page.sourcePageId, unitId: check.unitId }))
  }
  for (const unit of units) compatibility.represented.push(note("publication_unit", { unitId: unit.unitId }))
  for (const row of relationshipCensus) {
    const codes = { alias: "alias_team_fallback", shortlink: "shortlink_exact_destination", preview: "original_preview" }
    if (row.disposition === "pending" && codes[row.kind]) compatibility.represented.push(note(codes[row.kind], { unitId: row.unitId }))
  }
  for (const [category, issues] of Object.entries({ represented: compatibility.represented, unsupported: compatibility.unsupported, notObserved: compatibility.notObserved, warnings })) {
    for (const issue of issues) facts.push({ kind: "diagnostic", category, unitIds: issue.unitId ? [issue.unitId] : [], issue })
  }
  const base = { ok: false, fatal: null, schema: SELECTED_IMPORT_SCHEMA, kind: input.kind, sourceInstance: input.sourceInstance, targetBasis: input.targetBasis, ledger, facts, units, approvalRef: input.approvalRef, g1bRef: input.g1bRef }
  let finished = false
  const inventoryKeys = units.filter(unit => unit.status === "representable").map(unit => unit.inventoryKey)
  const keys = [...inventoryKeys, ...reads.map(read => read.sourceKey)]
  if (new Set(keys).size !== keys.length) throw new Error("duplicate_source_key")
  return { kind: "prepared", reads: structuredClone(reads), protectedLocators: structuredClone(protectedLocators), inventoryKeys, reader: structuredClone(input.reader), limits: structuredClone(input.limits), captureRoots: [...input.captureRoots], async finish(observations = {}) {
    if (finished) throw new Error("preflight_already_finished")
    finished = true
    const failures = []
    for (const read of reads) {
      const observed = observationOf(observations, read.path)
      let reason = null
      if (!observed) reason = "unknown"
      else if (observed.state !== "present") reason = observed.state
      else if (observed.size !== read.expected.size) reason = "size_mismatch"
      else if (observed.sha256 !== read.expected.sha256) reason = "digest_mismatch"
      if (reason) failures.push({ kind: "source", entryOrdinal: read.ordinal, stage: "inspect", reason })
    }
    return projectTranslation(base, failures)
  } }
}

// Projection is deliberately monotone: observations and pin failures may only
// demote a unit, never make a rejected fact or unit representable.
export function projectTranslation(translation, pinFailures = []) {
  if (translation.fatal !== null) {
    if (pinFailures.length) throw new Error("invalid_pin_failure")
    return translation
  }
  const failures = new Map()
  const knownUnits = new Set(translation.units.map(unit => unit.unitId))
  const facts = [...translation.facts]
  const entriesByOrdinal = new Map(facts.filter(fact => fact.kind === "entry" && fact.readCohort === "candidate").map(fact => [fact.ordinal, fact]))
  const knownIssues = new Set(facts.filter(fact => fact.kind === "diagnostic").map(fact => stable([fact.category, fact.issue])))
  const blockerIndexes = new Map(translation.units.map(unit => [unit.unitId, new Set(unit.blockers.map(stable))]))
  const add = (unitId, issue, category = "unsupported") => {
    const issueKey = stable(issue), key = stable([category, issue])
    if (!knownIssues.has(key)) {
      facts.push({ kind: "diagnostic", category, unitIds: [unitId], issue })
      knownIssues.add(key)
    }
    if (category === "unsupported") {
      const seen = blockerIndexes.get(unitId)
      if (!seen.has(issueKey)) {
        seen.add(issueKey)
        const list = failures.get(unitId) ?? []
        list.push(issue); failures.set(unitId, list)
      }
    }
  }
  for (const failure of pinFailures) {
    if (failure?.kind === "unit" && exact(failure, ["kind", "unitId", "code"]) && knownUnits.has(failure.unitId) && one(failure.code, ["budget_exceeded", "inventory_budget_exceeded"])) {
      add(failure.unitId, note(failure.code, { unitId: failure.unitId }))
      continue
    }
    if (!exact(failure, ["kind", "entryOrdinal", "stage", "reason"]) || failure.kind !== "source" || !integer(failure.entryOrdinal) || !one(failure.stage, ["inspect", "pin_reread"]) || !one(failure.reason, ["absent", "unreadable", "unknown", "changed", "size_mismatch", "digest_mismatch"])) throw new Error("invalid_pin_failure")
    const entry = entriesByOrdinal.get(failure.entryOrdinal)
    if (!entry || !knownUnits.has(entry.unitId)) throw new Error("invalid_pin_failure")
    const detail = { unitId: entry.unitId, entryOrdinal: entry.ordinal, path: entry.path, sourcePageId: entry.sourcePageId, stage: failure.stage, reason: failure.reason }
    const codes = { absent: "capture_absent", unreadable: "capture_unreadable", unknown: "capture_unknown", changed: "source_changed", size_mismatch: "capture_size_mismatch", digest_mismatch: "capture_fingerprint_mismatch" }
    const issue = { code: codes[failure.reason], ...detail }
    add(entry.unitId, issue)
    if (failure.reason === "unknown" || failure.reason === "unreadable") add(entry.unitId, issue, "notObserved")
    if (failure.reason === "absent" && entry.publicOrSharedDocument) add(entry.unitId, { code: "or1_missing_document", ...detail, basis: "observed_absent" })
  }
  const units = translation.units.map(unit => {
    const issues = failures.get(unit.unitId) ?? []
    if (unit.status === "blocked" || issues.length) {
      const { approval: _approval, ...rest } = unit
      const blockerKeys = new Set(unit.blockers.map(stable))
      return { ...rest, status: "blocked", pinState: "blocked", command: null, selection: null, inventory: null, blockers: [...unit.blockers, ...issues.filter(issue => !blockerKeys.has(stable(issue)))] }
    }
    return unit
  })
  const blocked = new Set(units.filter(unit => unit.status === "blocked").map(unit => unit.unitId))
  const census = [], accounting = []
  const compatibility = { represented: [], unsupported: [], notObserved: [] }, warnings = []
  for (const fact of facts) {
    const demoted = fact.unitIds.some(unitId => blocked.has(unitId))
    if (fact.kind === "diagnostic") {
      if (fact.category === "represented" && demoted) continue
      if (fact.category === "warnings") warnings.push(fact.issue)
      else compatibility[fact.category].push(fact.issue)
      continue
    }
    const disposition = fact.disposition === "represented" && demoted ? "rejected" : fact.disposition
    const unitId = fact.unitIds.length === 1 ? fact.unitIds[0] : null
    const row = censusOf([fact])[0]; row.disposition = disposition; census.push(row)
    if (fact.kind === "entry") accounting.push({ path: fact.path, unitId, disposition: disposition === "represented" ? "placed" : disposition === "excluded" ? "excluded" : "blocked", reason: demoted ? "unit_blocked" : fact.reason })
    if (fact.kind === "page" && fact.missingPath) accounting.push({ path: fact.missingPath, unitId, disposition: "blocked", reason: "missing_inventory_document" })
  }
  accounting.sort((a, b) => a.path < b.path ? -1 : 1)
  return { ...translation, facts, units, census, accounting, compatibility, warnings, ok: !translation.fatal && census.every(row => row.disposition !== "rejected") && compatibility.unsupported.length === 0 }
}

export function assignSourcePins(unit, pins) {
  if (!unit?.inventory || unit.status !== "representable") return { ok: false, code: "unit_not_representable" }
  if (!record(pins)) return { ok: false, code: "invalid_pins" }
  const files = []
  for (const file of unit.inventory.files) {
    const pin = pins[file.sourceRef]
    if (!pin || !exact(pin, ["version"]) || !text(pin.version) || pin.version === file.sha256 || pin.version === "placeholder") return { ok: false, code: "native_version_required", path: file.path }
    files.push({ ...file, sourceVersion: pin.version })
  }
  const inventory = { ...unit.inventory, files }
  const bytes = new TextEncoder().encode(stable(inventory))
  if (bytes.byteLength > unit.maxInventoryBytes) return { ok: false, code: "inventory_budget_exceeded" }
  return { ok: true, unit: { ...unit, pinState: "awaiting_inventory", inventory }, bytes }
}

export function sealInventory(unit, object, sha256) {
  if (!unit?.inventory || unit.pinState !== "awaiting_inventory" || !exact(object, ["key", "version"]) || !text(object.key) || !text(object.version) || !hex(sha256) || object.version === sha256) return { ok: false, code: "invalid_inventory_pin" }
  const approval = { inventoryId: unit.inventory.inventoryId, selectionId: unit.inventory.selectionId, sourceInstance: unit.inventory.sourceInstance, objectKey: object.key, objectVersion: object.version, sha256, approvalRef: unit.inventory.approvalRef, kind: unit.inventory.kind, g1bRef: unit.inventory.evidence.g1bRef, maxInventoryBytes: unit.maxInventoryBytes }
  return { ok: true, approval, unit: { ...unit, pinState: "pinned", approval } }
}
