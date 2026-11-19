// Translate one explicit operator selection into ordinary BeginCommand,
// ImportSelection and inventory drafts. This module does not open files,
// discover captures, decide access, or contact a provider. Native R2 versions
// are filled only by assignSourcePins after a real local PUT.
import { parseRequest } from "../domains/catalogue/routing/grammar.ts"
import { importPreviewOwned } from "../domains/catalogue/previews.ts"
import { conflictingImportOperationIndexes } from "../domains/catalogue/import-operation-set.ts"


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
function engineId(prefix) {
  return `${prefix}_${opaque()}`
}
export function emptyLedger() {
  return { version: 1, pages: {}, grants: {}, sourceArtifacts: {}, idempotencyKeys: {}, inventoryIds: {}, selectionIds: {}, planIds: {}, operationIds: {} }
}
function ledgerOf(value) {
  const ledger = emptyLedger()
  if (value == null) return ledger
  if (!exact(value, Object.keys(ledger)) || value.version !== 1) return null
  for (const key of Object.keys(ledger)) {
    if (key === "version") continue
    if (!record(value[key]) || Object.values(value[key]).some(item => typeof item !== "string" || !item)) return null
    ledger[key] = { ...value[key] }
  }
  return ledger
}
function remember(map, key, mint) {
  if (!Object.hasOwn(map, key) || typeof map[key] !== "string") Object.defineProperty(map, key, { value: mint(), enumerable: true, writable: true, configurable: true })
  return map[key]
}
function note(code, extra = {}) {
  const row = { code }
  for (const key of ["path", "sourcePageId", "unitId"]) if (extra[key]) row[key] = extra[key]
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
function slugOf(path) {
  if (!path.startsWith("/a/")) return null
  const slug = path.slice(3).split("/", 1)[0]
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null
}
function documentRoute(path) {
  const slug = slugOf(path)
  if (slug !== null) return path === `/a/${slug}/index.html` ? { kind: "subtree", slug } : null
  if (!path.startsWith("/") || path.startsWith("/a/")) return null
  const pageRef = path.slice(1)
  return /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.html$/.test(pageRef) && !pageRef.includes("..") ? { kind: "tree_page", pageRef } : null
}
function routeOf(path) {
  const route = documentRoute(path)
  return route ? route.kind === "subtree" ? `/a/${route.slug}/` : `/${route.pageRef}` : null
}
function shellPath(path, declared) {
  return declared.has(path) || path === "/index.html" || path === "/login.html" || path === "/404.html" || path === "/login"
}
function safeRelative(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false
  const parts = value.split("/")
  if (parts.some(part => !part || part === "." || part === "..")) return false
  const base = parts.at(-1)
  return base !== ".env" && !base.startsWith(".env.")
}
function observationOf(observations, path) {
  if (!record(observations) || !Object.hasOwn(observations, path)) return { state: "unknown" }
  const value = observations[path]
  if (!record(value) || !one(value.state, ["present", "absent", "unreadable", "unknown"])) return null
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
  const grammar = input.reader
  if (!exact(grammar, ["canonicalHost", "aliasHosts", "routeGrammars", "shareGrammars", "shareCookie", "shellPaths"]) || !text(grammar.canonicalHost) || !Array.isArray(grammar.aliasHosts) || grammar.aliasHosts.some(host => !text(host)) || typeof grammar.shareCookie !== "boolean" || !Array.isArray(grammar.shellPaths) || !Array.isArray(grammar.routeGrammars) || !Array.isArray(grammar.shareGrammars) || grammar.routeGrammars.length === 0 || grammar.routeGrammars.some(item => item !== "tree" && item !== "subtree") || grammar.shareGrammars.some(item => item !== "slug" && item !== "page" && item !== "card")) return "invalid_grammar"
  if (["captureRoots", "entries", "pages", "owners", "aliases", "shortlinks", "previews", "consumerUrls", "exclusions", "providerMounts"].some(key => !Array.isArray(input[key]))) return "invalid_selection"
  if (input.captureRoots.some(root => typeof root !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(root)) || new Set(input.captureRoots).size !== input.captureRoots.length) return "invalid_capture_root"
  return null
}
function aliasPath(value) {
  if (typeof value !== "string" || !/^\/[!-~]+$/.test(value) || value.startsWith("//")) return false
  let path = value
  for (;;) {
    if (/[\\\u0000-\u001f\u007f?#]/.test(path) || path.includes("//") || /%(?:2f|2e|5c)/i.test(path) || path.split("/").some(part => part === "." || part === "..")) return false
    if (!path.includes("%")) break
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) break
      path = decoded
    } catch { return false }
  }
  try { return new URL(value, "https://alias.invalid").origin === "https://alias.invalid" } catch { return false }
}
function shortlinkIdentity(link) {
  try {
    const provider = new URL(link.providerOrigin)
    const domain = new URL(`https://${link.shortDomain}`)
    const url = new URL(link.shortUrl)
    return provider.protocol === "https:" && provider.origin === link.providerOrigin && !provider.username && !provider.password && provider.pathname === "/" && !provider.search && !provider.hash &&
      domain.host === link.shortDomain && !domain.username && !domain.password && domain.pathname === "/" && !domain.search && !domain.hash &&
      (url.protocol === "https:" || url.protocol === "http:") && url.host === link.shortDomain && !url.username && !url.password && !url.search && !url.hash && url.pathname === `/${encodeURIComponent(link.shortCode)}` && url.href === link.shortUrl
  } catch { return false }
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
function targetMatches(parsed, page, entries) {
  const expected = documentRoute(page.documentPath)
  const matches = route => expected && route.kind === expected.kind && (route.kind === "subtree" ? route.slug === expected.slug : route.pageRef === expected.pageRef)
  const selected = path => entries.get(path)?.placement?.sourceArtifactId === page.membership.sourceArtifactId
  if (parsed?.kind === "share") return matches(parsed.route) && parsed.candidates.some(selected)
  if (parsed?.kind === "card") return parsed.targets.length === 1 && matches(parsed.targets[0].route) && selected(parsed.targets[0].path)
  if (parsed?.kind === "subtree") return expected?.kind === "subtree" && parsed.slug === expected.slug && parsed.candidates.some(selected)
  if (parsed?.kind === "tree") return expected?.kind === "tree_page" && parsed.pageRef === expected.pageRef && parsed.candidates.some(selected)
  return false
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
function rejectedCensus(input) {
  const kinds = [["entry", "entries"], ["page", "pages"], ["owner", "owners"], ["alias", "aliases"], ["shortlink", "shortlinks"], ["preview", "previews"], ["exclusion", "exclusions"], ["providerMount", "providerMounts"], ["consumerUrl", "consumerUrls"]]
  return kinds.flatMap(([kind, key]) => Array.isArray(input?.[key]) ? input[key].map((_row, ordinal) => ({ kind, ordinal, unitId: null, disposition: "rejected" })) : [])
}


export async function preflightSelection(input, ledgerInput = null) {
  const compatibility = { represented: [], unsupported: [], notObserved: [] }
  const warnings = []
  const accounting = []
  const seen = new Set()
  const account = (path, disposition, unitId, reason) => {
    if (!path || seen.has(path)) return
    seen.add(path)
    accounting.push({ path, disposition, unitId: unitId ?? entries.get(path)?.placement?.sourceArtifactId ?? null, reason })
  }
  const fatal = header(input)
  const ledger = ledgerOf(ledgerInput)
  if (fatal || !ledger) {
    return { kind: "fatal", result: { ok: false, fatal: fatal ?? "invalid_ledger", schema: SELECTED_IMPORT_SCHEMA, ledger: ledger ?? emptyLedger(), accounting, census: rejectedCensus(input), units: [], compatibility: { represented: [], unsupported: [note(fatal ?? "invalid_ledger")], notObserved: [] }, warnings } }
  }
  try { input = structuredClone(input) } catch {
    return { kind: "fatal", result: { ok: false, fatal: "invalid_selection", schema: SELECTED_IMPORT_SCHEMA, ledger, accounting, census: rejectedCensus(input), units: [], compatibility: { represented: [], unsupported: [note("invalid_selection")], notObserved: [] }, warnings } }
  }
  const roots = new Set(input.captureRoots)
  const shells = new Set(input.reader.shellPaths.filter(path => typeof path === "string"))
  const entries = new Map()
  let contradictory = false
  for (const entry of input.entries) {
    const path = record(entry) && typeof entry.path === "string" ? entry.path : undefined
    const nonContent = one(entry?.graphClass, ["shell", "excluded", "unresolved"])
    const validFingerprint = exact(entry?.expected, ["size", "sha256"]) && integer(entry.expected.size) && entry.expected.size >= 0 && hex(entry.expected.sha256)
    if (!exact(entry, ["path", "graphClass", "locator", "contentType", "provenance", "expected", "placement"]) || !validPath(entry.path, nonContent) || !one(entry.graphClass, ["page_document", "subdocument", "fragment", "asset", "shell", "excluded", "unresolved"]) || !(nonContent ? entry.placement === null : exact(entry.placement, ["sourceArtifactId", "evidenceRef"]) && text(entry.placement.sourceArtifactId) && text(entry.placement.evidenceRef)) || !exact(entry.locator, ["root", "relative"]) || !(validFingerprint || (nonContent && entry.expected === null)) || !text(entry.provenance) || !(entry.contentType === null || text(entry.contentType, 255))) {
      contradictory = true
      compatibility.unsupported.push(note("contradictory_entry", { path }))
      if (path) account(path, "blocked", null, "contradictory_entry")
      continue
    }
    if (entries.has(entry.path)) {
      contradictory = true
      compatibility.unsupported.push(note("duplicate_path", { path: entry.path }))
    }
    if (!roots.has(entry.locator.root) || !safeRelative(entry.locator.relative)) compatibility.unsupported.push(note("unsafe_locator", { path: entry.path }))
    entries.set(entry.path, entry)
  }
  const exclusions = new Map()
  for (const exclusion of input.exclusions) {
    if (!exact(exclusion, ["path", "evidenceRef", "reason"]) || !text(exclusion.path) || !text(exclusion.evidenceRef) || !one(exclusion.reason, ["shell", "engine", "non_content"])) {
      contradictory = true
      compatibility.unsupported.push(note("contradictory_exclusion"))
      continue
    }
    if (exclusions.has(exclusion.path)) contradictory = true
    exclusions.set(exclusion.path, exclusion)
  }
  if (contradictory) {
    for (const path of entries.keys()) account(path, "blocked", null, "contradictory_input")
    return { kind: "fatal", result: { ok: false, fatal: "contradictory_input", schema: SELECTED_IMPORT_SCHEMA, ledger, accounting, census: rejectedCensus(input), units: [], compatibility, warnings, sourceInstance: input.sourceInstance, kind: input.kind } }
  }
  const placed = new Map()
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
      if (valid && kind === "owner") valid = text(row.path) && text(row.evidenceRef) && row.basis === "declared" && (["fragment", "asset"].includes(entries.get(row.path)?.graphClass) || input.providerMounts.some(mount => record(mount) && mount.path === row.path))
      if (valid && kind === "alias") valid = one(row.aliasKind, ["redirect_exact", "redirect_prefix"]) && aliasPath(row.path) && aliasPath(row.to) && [301, 302, 307, 308].includes(row.status) && row.capturedBehavior === "team_fallback" && (row.aliasKind !== "redirect_prefix" || row.path.endsWith("/"))
      if (valid && kind === "shortlink") valid = text(row.mappingId) && text(row.providerOrigin) && (row.providerId === null || text(row.providerId)) && text(row.shortDomain) && text(row.shortCode) && text(row.shortUrl) && text(row.destination, 4096) && integer(row.observedAt) && row.observedAt >= 0 && shortlinkIdentity(row)
      if (valid && kind === "preview") valid = validPath(row.path) && one(row.kind, ["original", "derived_only"]) && entries.has(row.path)
      const identity = valid ? stable([kind, row]) : null
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
  for (const mount of input.providerMounts) {
    const dependents = input.owners.filter(owner => owner?.path === mount?.path).map(owner => pageBySource.get(owner.ownerSourcePageId)?.membership.sourceArtifactId).filter(Boolean)
    if (!exact(mount, ["artifactId", "path", "kind"]) || !ENGINE_ID.test(mount.artifactId) || !mount.artifactId.startsWith("ar_") || !validPath(mount.path) || !one(mount.kind, ["fragment", "asset"]) || !dependents.length) unassignable = true
    for (const unitId of dependents) {
      relationshipBlocked.add(unitId)
      compatibility.unsupported.push(note("provider_mount_unverified", { unitId }))
    }
  }
  if (unassignable) {
    compatibility.unsupported.push(note("unassignable_record"))
    return { kind: "fatal", result: { ok: false, fatal: "unassignable_record", schema: SELECTED_IMPORT_SCHEMA, ledger, accounting, census: rejectedCensus(input), units: [], compatibility, warnings, sourceInstance: input.sourceInstance, kind: input.kind } }
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
    if (!entry || entry.graphClass !== "page_document" || entry.placement?.sourceArtifactId !== unitId) code = page.visibility.state === "present" && ["public", "shared"].includes(page.visibility.value) ? "or1_missing_document" : "page_without_document"
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
      compatibility.unsupported.push(note(code, { path: page.documentPath, sourcePageId: page.sourcePageId, unitId }))
      if (code === "visibility_unknown" || code === "visibility_unreadable" || code === "share_key_unknown" || code === "share_key_unreadable") compatibility.notObserved.push(note(code, { sourcePageId: page.sourcePageId, unitId }))
    }
  }
  for (const entry of entries.values()) if (entry.placement && !selectedByUnit.has(entry.placement.sourceArtifactId)) {
    const unitId = entry.placement.sourceArtifactId
    selectedByUnit.set(unitId, [])
    blockedUnits.add(unitId)
    compatibility.unsupported.push(note("placement_without_membership", { path: entry.path, unitId }))
  }
  if (input.targetBasis !== "empty") for (const unitId of selectedByUnit.keys()) blockedUnits.add(unitId)
  for (const entry of entries.values()) {
    if (!entry.placement) continue
    let code = null
    if (!roots.has(entry.locator.root) || !safeRelative(entry.locator.relative) || !text(`capture/${entry.locator.root}/${entry.locator.relative}`)) code = "unsafe_locator"
    else if (entry.contentType === null || !MIME.test(entry.contentType) || (entry.graphClass === "asset" && entry.path.endsWith(".html")) || (entry.graphClass === "page_document" && (!documentRoute(entry.path) || entry.contentType !== "text/html")) || (entry.graphClass === "subdocument" && (entry.contentType !== "text/html" || !entry.path.endsWith(".html"))) || (entry.graphClass === "fragment" && entry.contentType !== "text/html")) code = "contradictory_class"
    else if ((ownersByPath.get(entry.path)?.length ?? 0) > LIMITS.owners) code = "uncapped_owners"
    else if (entry.expected.size > Math.min(input.limits.maxUploadBytes, LIMITS.fileBytes)) code = "file_bytes"
    if (code) {
      blockedUnits.add(entry.placement.sourceArtifactId)
      compatibility.unsupported.push(note(code, { path: entry.path, unitId: entry.placement.sourceArtifactId }))
    }
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
    const pageId = remember(ledger.pages, page.sourcePageId, () => engineId("pg"))
    const entry = entries.get(preview.path)
    const files = entry?.placement?.sourceArtifactId === unitId ? [{ path: entry.path, contentType: entry.contentType }] : []
    const edges = (ownersByPath.get(preview.path) ?? []).filter(owner => owner.ownerSourcePageId === page.sourcePageId).map(() => ({ ownerPageId: pageId, path: preview.path, providerArtifactId: null }))
    if (!importPreviewOwned({ artifactId: null, files, pages: [{ pageId, disposition: "new", documentPath: page.documentPath }], edges }, pageId, preview.path)) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("preview_not_owned", { path: preview.path, sourcePageId: page.sourcePageId, unitId }))
    }
  }
  const consumerChecks = []
  for (let ordinal = 0; ordinal < input.consumerUrls.length; ordinal++) {
    const row = input.consumerUrls[ordinal]
    const mapping = record(row) && typeof row.mappingRef === "string" ? input.shortlinks.find(link => link.mappingId === row.mappingRef) : null
    const page = record(row) ? pageBySource.get(row.targetSourcePageId ?? mapping?.targetSourcePageId) : null
    if (!page || (mapping && row.targetSourcePageId !== null && row.targetSourcePageId !== mapping.targetSourcePageId)) { unassignable = true; continue }
    const unitId = page.membership.sourceArtifactId
    let valid = exact(row, ["url", "purpose", "targetSourcePageId", "mappingRef"]) && typeof row.url === "string" && one(row.purpose, ["share", "card", "alias", "shortlink", "document"])
    const parsed = valid ? parsedConsumer(row.url, input.reader) : null
    if (valid && row.purpose === "shortlink") valid = !!mapping && mapping.shortUrl === row.url
    else if (valid && row.purpose === "alias") {
      try {
        const target = new URL(row.url)
        valid = target.protocol === "https:" && !target.username && !target.password && !target.port && [input.reader.canonicalHost, ...input.reader.aliasHosts].includes(target.hostname) && input.aliases.some(alias => alias.path === target.pathname && alias.targetSourcePageId === page.sourcePageId)
      } catch { valid = false }
    } else if (valid) {
      const kindMatches = row.purpose === "share" ? parsed?.kind === "share" : row.purpose === "card" ? parsed?.kind === "card" : parsed?.kind === "tree" || parsed?.kind === "subtree"
      valid = !!parsed && kindMatches && targetMatches(parsed, page, entries)
      if (valid && (parsed.kind === "share" || parsed.kind === "card")) valid = page.visibility.state === "present" && page.visibility.value === "shared" && page.share.state === "present" && parsed.key === page.share.key
    }
    const code = parsed?.kind === "card" && parsed.targets.length > 1 ? "two_candidate_card" : "consumer_url_unsupported"
    if (!valid) blockedUnits.add(unitId)
    consumerChecks.push({ ordinal, page, unitId, valid: !!valid, code })
  }
  if (unassignable) {
    compatibility.unsupported.push(note("unassignable_record"))
    return { kind: "fatal", result: { ok: false, fatal: "unassignable_record", schema: SELECTED_IMPORT_SCHEMA, ledger, accounting, census: rejectedCensus(input), units: [], compatibility, warnings, sourceInstance: input.sourceInstance, kind: input.kind } }
  }
  const policyOperations = new Map(), relationshipOperations = new Map(), proposed = [], proposedUnits = []
  const addProposal = (operation, unitId) => { proposed.push(operation); proposedUnits.push(unitId) }
  for (const page of pages) {
    const unitId = page.membership.sourceArtifactId
    if (blockedUnits.has(unitId)) continue
    const pageId = remember(ledger.pages, page.sourcePageId, () => engineId("pg"))
    const visibilityValue = page.visibility.state === "present" ? page.visibility.value : null
    const shareKey = page.share.state === "present" ? page.share.key : null
    const grantId = visibilityValue === "shared" ? remember(ledger.grants, page.sourcePageId, () => engineId("gr")) : null
    const operation = { kind: "page_policy", policy: { operationId: remember(ledger.operationIds, `policy:${page.sourcePageId}`, () => `op${opaque()}`), sourcePageId: page.sourcePageId, pageId, expectedPolicyEpoch: null, grantId, visibility: { captured: true, value: visibilityValue, metadataV: page.visibility.state === "present" ? page.visibility.metadataV : null, expiresAt: null }, share: { captured: true, key: shareKey, expiresAt: page.share.state === "present" ? page.share.expiresAt : null } } }
    policyOperations.set(page.sourcePageId, operation)
    addProposal(operation, unitId)
  }
  for (const alias of input.aliases) {
    const page = pageBySource.get(alias?.targetSourcePageId), unitId = page?.membership.sourceArtifactId
    if (!page || blockedUnits.has(unitId) || !exact(alias, ["aliasKind", "path", "to", "status", "targetSourcePageId", "capturedBehavior"]) || !one(alias.aliasKind, ["redirect_exact", "redirect_prefix"]) || !aliasPath(alias.path) || !aliasPath(alias.to) || ![301, 302, 307, 308].includes(alias.status) || alias.capturedBehavior !== "team_fallback") continue
    const operation = { kind: "alias", operationId: remember(ledger.operationIds, `alias:${alias.path}`, () => `op${opaque()}`), aliasKind: alias.aliasKind, path: alias.path, to: alias.to, status: alias.status, targetPageId: policyOperations.get(page.sourcePageId).policy.pageId }
    relationshipOperations.set(alias, operation); addProposal(operation, unitId)
  }
  for (const link of input.shortlinks) {
    const page = pageBySource.get(link?.targetSourcePageId), unitId = page?.membership.sourceArtifactId
    if (!page || blockedUnits.has(unitId) || !exact(link, ["mappingId", "providerOrigin", "providerId", "shortDomain", "shortCode", "shortUrl", "targetSourcePageId", "destination", "observedAt"]) || !text(link.mappingId) || !text(link.destination, 4096) || !integer(link.observedAt) || link.observedAt < 0 || !shortlinkIdentity(link)) continue
    const policy = policyOperations.get(page.sourcePageId).policy
    const parsed = parsedConsumer(link.destination, input.reader)
    const keyed = parsed?.kind === "share" || parsed?.kind === "card"
    const validTarget = parsed && targetMatches(parsed, page, entries)
    const grantId = validTarget && keyed && policy.visibility.value === "shared" && parsed.key === policy.share.key ? policy.grantId : null
    if (!validTarget || (keyed && !grantId)) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("shortlink_destination_unverified", { sourcePageId: page.sourcePageId, unitId }))
      continue
    }
    const operation = { kind: "shortlink", operationId: remember(ledger.operationIds, `shortlink:${link.mappingId}`, () => `op${opaque()}`), mapping: { mappingId: link.mappingId, providerOrigin: link.providerOrigin, providerId: link.providerId, shortDomain: link.shortDomain, shortCode: link.shortCode, shortUrl: link.shortUrl, pageId: policy.pageId, grantId, destination: link.destination, source: "imported", observedAt: link.observedAt, destinationDigest: await digest(link.destination) } }
    relationshipOperations.set(link, operation); addProposal(operation, unitId)
  }
  for (const preview of input.previews) {
    const page = pageBySource.get(preview?.sourcePageId), unitId = page?.membership.sourceArtifactId
    if (!page || blockedUnits.has(unitId) || preview.kind !== "original" || !validPath(preview.path)) continue
    const operation = { kind: "preview_selection", operationId: remember(ledger.operationIds, `preview:${preview.sourcePageId}:${preview.path}`, () => `op${opaque()}`), pageId: policyOperations.get(page.sourcePageId).policy.pageId, path: preview.path }
    relationshipOperations.set(preview, operation); addProposal(operation, unitId)
  }
  for (const index of conflictingImportOperationIndexes(proposed)) {
    const unitId = proposedUnits[index]
    blockedUnits.add(unitId)
    if (!compatibility.unsupported.some(issue => issue.code === "conflicting_import_operations" && issue.unitId === unitId)) compatibility.unsupported.push(note("conflicting_import_operations", { unitId }))
  }
  const fileCounts = new Map(), edgeCounts = new Map()
  for (const entry of entries.values()) if (entry.placement) fileCounts.set(entry.placement.sourceArtifactId, (fileCounts.get(entry.placement.sourceArtifactId) ?? 0) + 1)
  for (const owner of owners) {
    const unitId = pageBySource.get(owner.ownerSourcePageId)?.membership.sourceArtifactId
    if (unitId) edgeCounts.set(unitId, (edgeCounts.get(unitId) ?? 0) + 1)
  }
  for (const [unitId, members] of selectedByUnit) {
    if (members.length > LIMITS.pages || (fileCounts.get(unitId) ?? 0) > LIMITS.files || (edgeCounts.get(unitId) ?? 0) > LIMITS.edges) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("budget_exceeded", { unitId }))
    }
  }
  const staticEntries = new Map(), staticEdges = new Map(), staticOperations = new Map(), staticBudgets = new Map()
  for (const entry of entries.values()) if (entry.placement) {
    const unitId = entry.placement.sourceArtifactId
    const list = staticEntries.get(unitId) ?? []; list.push(entry); staticEntries.set(unitId, list)
    if (shellPath(entry.path, shells)) blockedUnits.add(unitId)
  }
  for (const [path, list] of ownersByPath) for (const owner of list) {
    const unitId = pageBySource.get(owner.ownerSourcePageId)?.membership.sourceArtifactId
    if (!unitId) continue
    const rows = staticEdges.get(unitId) ?? []
    rows.push({ ownerPageId: ledger.pages[owner.ownerSourcePageId], path, providerArtifactId: null, evidenceRef: owner.evidenceRef })
    staticEdges.set(unitId, rows)
  }
  for (let index = 0; index < proposed.length; index++) {
    const unitId = proposedUnits[index], rows = staticOperations.get(unitId) ?? []
    rows.push(proposed[index]); staticOperations.set(unitId, rows)
  }
  for (const [unitId, members] of selectedByUnit) {
    if (blockedUnits.has(unitId)) continue
    const sourceEntries = (staticEntries.get(unitId) ?? []).slice().sort((a, b) => a.path < b.path ? -1 : 1)
    const files = sourceEntries.map(entry => ({ path: entry.path, kind: entry.graphClass === "page_document" ? "document" : entry.graphClass, sha256: entry.expected.sha256, size: entry.expected.size, contentType: entry.contentType, source: "client" }))
    const pagesOut = members.map(page => ({ pageId: policyOperations.get(page.sourcePageId).policy.pageId, disposition: "new", documentPath: page.documentPath, metadata: page.metadata, expectedPolicyEpoch: null })).sort((a, b) => a.pageId < b.pageId ? -1 : 1)
    const edges = staticEdges.get(unitId) ?? []
    const command = { idempotencyKey: remember(ledger.idempotencyKeys, unitId, () => `k${opaque()}`), artifactId: null, expectedRevisionId: null, expectedContentVersion: 0, files, pages: pagesOut, edges: edges.map(({ evidenceRef: _evidence, ...edge }) => edge) }
    const inventoryId = remember(ledger.inventoryIds, unitId, () => `inv${opaque()}`)
    const selectionId = remember(ledger.selectionIds, unitId, () => `sel${opaque()}`)
    const selection = { version: 1, inventoryId, selectionId, planId: remember(ledger.planIds, unitId, () => `plan${opaque()}`), command }
    const inventory = { version: 1, inventoryId, selectionId, sourceInstance: input.sourceInstance, sourceArtifactId: unitId, approvalRef: input.approvalRef, kind: input.kind, command,
      pageMappings: members.map(page => ({ sourcePageId: page.sourcePageId, pageId: policyOperations.get(page.sourcePageId).policy.pageId, documentPath: page.documentPath, route: routeOf(page.documentPath), ownershipEvidenceRef: page.ownershipEvidenceRef })).sort((a, b) => a.pageId < b.pageId ? -1 : 1),
      edgeEvidence: edges, evidence: { selectionDigest: input.selectionDigest, corpusDigest: input.corpusDigest, mappingRef: input.mappingRef, capturedAt: input.capturedAt, complete: true, g1bRef: input.g1bRef },
      files: sourceEntries.map(entry => ({ path: entry.path, kind: entry.graphClass === "page_document" ? "document" : entry.graphClass, contentType: entry.contentType, size: entry.expected.size, sha256: entry.expected.sha256, sourceRef: `capture/${entry.locator.root}/${entry.locator.relative}`, sourceVersion: null, provenance: entry.provenance })), operations: staticOperations.get(unitId) ?? [] }
    const cost = budget(selection, utf8(stable(inventory)), input.limits)
    staticBudgets.set(unitId, cost)
    if (cost.failed.length) {
      blockedUnits.add(unitId)
      compatibility.unsupported.push(note("budget_exceeded", { unitId, budget: cost }))
    }
  }
  for (const unitId of selectedByUnit.keys()) {
    remember(ledger.idempotencyKeys, unitId, () => `k${opaque()}`)
    remember(ledger.inventoryIds, unitId, () => `inv${opaque()}`)
    remember(ledger.selectionIds, unitId, () => `sel${opaque()}`)
    remember(ledger.planIds, unitId, () => `plan${opaque()}`)
  }
  const readOrdinals = [], protectedOrdinals = []
  for (let ordinal = 0; ordinal < input.entries.length; ordinal++) {
    const entry = input.entries[ordinal]
    const read = entry.placement && !blockedUnits.has(entry.placement.sourceArtifactId) && !shellPath(entry.path, shells) && roots.has(entry.locator.root) && safeRelative(entry.locator.relative)
    ;(read ? readOrdinals : protectedOrdinals).push(ordinal)
  }
  let finished = false
  return { kind: "prepared", readOrdinals, protectedOrdinals, async finish(observations = {}) {
  if (finished) throw new Error("preflight_already_finished")
  finished = true
  for (const entry of entries.values()) {
    const path = entry.path
    if (entry.placement && blockedUnits.has(entry.placement.sourceArtifactId)) {
      account(path, "blocked", entry.placement.sourceArtifactId, "preflight_blocked")
      continue
    }
    if (entry.graphClass === "shell" || entry.graphClass === "excluded" || shellPath(path, shells)) {
      const exclusion = exclusions.get(path)
      if (!exclusion) {
        compatibility.unsupported.push(note("exclusion_evidence_required", { path }))
        account(path, "blocked", null, "exclusion_evidence_required")
      } else {
        compatibility.represented.push(note("excluded", { path }))
        account(path, "excluded", null, exclusion.reason)
      }
      continue
    }
    if (entry.graphClass === "unresolved") {
      compatibility.unsupported.push(note("unresolved_path", { path }))
      account(path, "blocked", null, "unresolved_path")
      continue
    }
    if (!roots.has(entry.locator.root) || !safeRelative(entry.locator.relative) || !text(`capture/${entry.locator.root}/${entry.locator.relative}`)) {
      compatibility.unsupported.push(note("unsafe_locator", { path }))
      account(path, "blocked", null, "unsafe_locator")
      continue
    }
    const observed = observationOf(observations, path)
    if (!observed) {
      compatibility.unsupported.push(note("contradictory_capture", { path }))
      account(path, "blocked", null, "contradictory_capture")
      continue
    }
    const page = pageByPath.get(path)
    if (observed.state !== "present") {
      const publicMissing = page && (page.visibility.state === "present" && (page.visibility.value === "public" || page.visibility.value === "shared"))
      const code = observed.state === "absent" && publicMissing ? "or1_missing_document" : observed.state === "absent" ? "capture_absent" : observed.state === "unreadable" ? "capture_unreadable" : "capture_unknown"
      compatibility.unsupported.push(note(code, { path, sourcePageId: page?.sourcePageId }))
      if (observed.state === "unknown" || observed.state === "unreadable") compatibility.notObserved.push(note(code, { path, sourcePageId: page?.sourcePageId }))
      account(path, "blocked", null, code)
      continue
    }
    if (observed.size !== entry.expected.size || observed.sha256 !== entry.expected.sha256) {
      compatibility.unsupported.push(note("capture_fingerprint_mismatch", { path }))
      account(path, "blocked", null, "capture_fingerprint_mismatch")
      continue
    }
    if (entry.contentType === null || !MIME.test(entry.contentType) || (entry.graphClass === "asset" && path.endsWith(".html")) || (entry.graphClass === "page_document" && (!documentRoute(path) || entry.contentType !== "text/html")) || (entry.graphClass === "subdocument" && (entry.contentType !== "text/html" || !path.endsWith(".html"))) || (entry.graphClass === "fragment" && entry.contentType !== "text/html")) {
      compatibility.unsupported.push(note("contradictory_class", { path }))
      account(path, "blocked", null, "contradictory_class")
      continue
    }
    if ((ownersByPath.get(path)?.length ?? 0) > LIMITS.owners) {
      compatibility.unsupported.push(note("uncapped_owners", { path }))
      account(path, "blocked", null, "uncapped_owners")
      continue
    }
    placed.set(path, { entry, observed })
  }
  const pageState = new Map()
  for (const page of pages) {
    const item = placed.get(page.documentPath)
    if (!item || item.entry.graphClass !== "page_document") {
      if (!entries.has(page.documentPath)) {
        const code = page.visibility.state === "present" && ["public", "shared"].includes(page.visibility.value) ? "or1_missing_document" : "page_without_document"
        compatibility.unsupported.push(note(code, { path: page.documentPath, sourcePageId: page.sourcePageId }))
        account(page.documentPath, "blocked", null, code)
      } else compatibility.unsupported.push(note("page_without_document", { path: page.documentPath, sourcePageId: page.sourcePageId }))
      continue
    }
    const expected = slugOf(page.documentPath) ?? page.documentPath.slice(1)
    if (page.sourcePageId !== expected) {
      compatibility.unsupported.push(note("source_identity_mismatch", { path: page.documentPath, sourcePageId: page.sourcePageId }))
      placed.delete(page.documentPath)
      account(page.documentPath, "blocked", null, "source_identity_mismatch")
      continue
    }
    if (page.metadata === null) {
      compatibility.unsupported.push(note("missing_metadata", { path: page.documentPath, sourcePageId: page.sourcePageId }))
      placed.delete(page.documentPath)
      account(page.documentPath, "blocked", null, "missing_metadata")
      continue
    }
    let metadataLength = Infinity
    try { metadataLength = stable(page.metadata).length } catch { /* Invalid JSON metadata is rejected below. */ }
    if (metadataLength > 8192) {
      compatibility.unsupported.push(note("metadata_too_large", { path: page.documentPath, sourcePageId: page.sourcePageId }))
      placed.delete(page.documentPath)
      account(page.documentPath, "blocked", null, "metadata_too_large")
      continue
    }
    const visibility = page.visibility
    const share = page.share
    if (visibility.state === "unknown" || visibility.state === "unreadable" || share.state === "unknown" || share.state === "unreadable") {
      const code = visibility.state === "unknown" || visibility.state === "unreadable" ? `visibility_${visibility.state}` : `share_key_${share.state}`
      compatibility.unsupported.push(note(code, { path: page.documentPath, sourcePageId: page.sourcePageId }))
      compatibility.notObserved.push(note(code, { sourcePageId: page.sourcePageId }))
      placed.delete(page.documentPath)
      account(page.documentPath, "blocked", null, code)
      continue
    }
    let visibilityValue = null
    if (visibility.state === "absent") compatibility.represented.push(note("visibility_absent_private", { sourcePageId: page.sourcePageId }))
    else if (visibility.metadataV !== null && visibility.metadataV !== visibility.value) {
      compatibility.unsupported.push(note("visibility_metadata_mismatch", { sourcePageId: page.sourcePageId, path: page.documentPath }))
      placed.delete(page.documentPath)
      account(page.documentPath, "blocked", null, "visibility_metadata_mismatch")
      continue
    } else if (visibility.value !== null && !["private", "public", "shared"].includes(visibility.value)) {
      warnings.push(note("unknown_visibility_private", { sourcePageId: page.sourcePageId }))
      visibilityValue = visibility.value
    } else visibilityValue = visibility.value
    if ((visibility.state === "present" && visibility.expiresAt !== null) || (visibilityValue === "shared" && share.state === "present" && share.expiresAt !== null)) {
      compatibility.unsupported.push(note("expiring_policy_unsupported", { sourcePageId: page.sourcePageId, path: page.documentPath }))
      placed.delete(page.documentPath)
      account(page.documentPath, "blocked", null, "expiring_policy_unsupported")
      continue
    }
    let shareKey = null
    if (visibilityValue === "shared") {
      if (share.state !== "present" || typeof share.key !== "string" || !SHARE_KEY.test(share.key)) {
        const code = share.state === "absent" ? "share_key_absent" : share.state === "unknown" ? "share_key_unknown" : "invalid_share_key"
        compatibility.unsupported.push(note(code, { sourcePageId: page.sourcePageId, path: page.documentPath }))
        if (share.state === "unknown" || share.state === "unreadable") compatibility.notObserved.push(note(code, { sourcePageId: page.sourcePageId }))
        placed.delete(page.documentPath)
        account(page.documentPath, "blocked", null, code)
        continue
      }
      shareKey = share.key
    } else if (share.state === "present" && share.key !== null) {
      shareKey = share.key
      compatibility.unsupported.push(note("share_key_not_imported", { sourcePageId: page.sourcePageId }))
    }
    const policy = policyOperations.get(page.sourcePageId).policy
    pageState.set(page.sourcePageId, { page, pageId: policy.pageId, grantId: policy.grantId, visibilityValue: policy.visibility.value, shareKey: policy.share.key, metadataV: policy.visibility.metadataV })
  }
  for (const [path, item] of [...placed]) {
    if (item.entry.graphClass !== "fragment") continue
    const live = (ownersByPath.get(path) ?? []).filter(owner => pageState.has(owner.ownerSourcePageId))
    if (!live.length) {
      compatibility.unsupported.push(note("fragment_without_owner", { path }))
      placed.delete(path)
      account(path, "blocked", null, "fragment_without_owner")
    }
  }
  const groups = new Map([...selectedByUnit.keys()].map(unitId => [unitId, []]))
  for (const page of pages) {
    const unitId = page.membership.sourceArtifactId
    if (!groups.has(unitId)) groups.set(unitId, [])
    const state = pageState.get(page.sourcePageId)
    if (state && placed.has(page.documentPath)) groups.get(unitId).push(state)
  }
  for (const entry of entries.values()) {
    if (entry.placement && !groups.has(entry.placement.sourceArtifactId)) {
      unassignable = true
      compatibility.unsupported.push(note("placement_without_membership", { path: entry.path }))
      account(entry.path, "blocked", entry.placement.sourceArtifactId, "placement_without_membership")
    }
  }
  const assigned = new Set()
  const units = []
  const entriesByUnit = new Map()
  for (const entry of entries.values()) if (entry.placement) {
    const list = entriesByUnit.get(entry.placement.sourceArtifactId) ?? []
    list.push(entry)
    entriesByUnit.set(entry.placement.sourceArtifactId, list)
  }
  for (const [unitId, list] of [...groups].sort(([left], [right]) => left < right ? -1 : 1)) {
    const sources = new Set(list.map(item => item.page.sourcePageId))
    const local = new Set()
    const edges = []
    const dependencies = []
    for (const entry of entriesByUnit.get(unitId) ?? []) if (placed.has(entry.path)) local.add(entry.path)
    for (const path of local) assigned.add(path)
    const files = [...local].sort().map(path => {
      const item = placed.get(path)
      return { path, kind: item.entry.graphClass === "page_document" ? "document" : item.entry.graphClass, sha256: item.observed.sha256, size: item.observed.size, contentType: item.entry.contentType, source: "client" }
    })
    for (const [path, listOwners] of ownersByPath) {
      for (const owner of listOwners) {
        if (!sources.has(owner.ownerSourcePageId) || !pageState.has(owner.ownerSourcePageId)) continue
        if (local.has(path)) edges.push({ ownerPageId: pageState.get(owner.ownerSourcePageId).pageId, path, providerArtifactId: null, evidenceRef: owner.evidenceRef })
        else {
          dependencies.push({ path, providerArtifactId: null, state: "missing" })
          compatibility.unsupported.push(note("provider_mount_required", { path, unitId }))
        }
      }
    }
    const pagesOut = list.filter(item => local.has(item.page.documentPath)).map(item => ({ pageId: item.pageId, disposition: "new", documentPath: item.page.documentPath, metadata: item.page.metadata, expectedPolicyEpoch: null })).sort((left, right) => left.pageId < right.pageId ? -1 : 1)
    const operations = []
    for (const item of list) {
      if (!local.has(item.page.documentPath)) continue
      operations.push(policyOperations.get(item.page.sourcePageId))
    }
    for (const alias of input.aliases) {
      if (!exact(alias, ["aliasKind", "path", "to", "status", "targetSourcePageId", "capturedBehavior"]) || !one(alias.aliasKind, ["redirect_exact", "redirect_prefix"]) || !one(alias.capturedBehavior, ["team_fallback", "public", "query_forward", "rewrite", "unobserved"])) {
        compatibility.unsupported.push(note("contradictory_alias", { unitId }))
        continue
      }
      if (!sources.has(alias.targetSourcePageId)) continue
      if (alias.capturedBehavior !== "team_fallback") {
        compatibility.unsupported.push(note(alias.capturedBehavior === "query_forward" ? "alias_query_not_forwarded" : alias.capturedBehavior === "public" ? "alias_public_unsupported" : "alias_behavior_unobserved", { path: alias.path, unitId }))
        continue
      }
      if (!aliasPath(alias.path) || !aliasPath(alias.to) || ![301, 302, 307, 308].includes(alias.status) || (alias.aliasKind === "redirect_prefix" && !alias.path.endsWith("/"))) {
        compatibility.unsupported.push(note("alias_invalid", { path: alias.path, unitId }))
        continue
      }
      operations.push(relationshipOperations.get(alias))
      compatibility.represented.push(note("alias_team_fallback", { path: alias.path, unitId }))
    }
    for (const link of input.shortlinks) {
      if (!exact(link, ["mappingId", "providerOrigin", "providerId", "shortDomain", "shortCode", "shortUrl", "targetSourcePageId", "destination", "observedAt"]) || !sources.has(link.targetSourcePageId)) continue
      if (!text(link.mappingId) || !text(link.providerOrigin) || !(link.providerId === null || text(link.providerId)) || !text(link.shortDomain) || !text(link.shortCode) || !text(link.shortUrl) || !text(link.destination, 4096) || !integer(link.observedAt) || link.observedAt < 0 || !shortlinkIdentity(link)) {
        compatibility.unsupported.push(note("shortlink_invalid", { sourcePageId: link.targetSourcePageId, unitId }))
        continue
      }
      operations.push(relationshipOperations.get(link))
      compatibility.represented.push(note("shortlink_exact_destination", { sourcePageId: link.targetSourcePageId, unitId }))
    }
    for (const preview of input.previews) {
      if (!exact(preview, ["sourcePageId", "path", "kind"]) || !one(preview.kind, ["original", "derived_only"])) {
        compatibility.unsupported.push(note("contradictory_preview", { unitId }))
        continue
      }
      if (!sources.has(preview.sourcePageId)) continue
      if (preview.kind !== "original") {
        compatibility.unsupported.push(note("derived_preview_unsupported", { path: preview.path, sourcePageId: preview.sourcePageId, unitId }))
        continue
      }
      const page = pageState.get(preview.sourcePageId)
      const owned = importPreviewOwned({ artifactId: null, files, pages: pagesOut, edges }, page.pageId, preview.path)
      if (!owned) {
        compatibility.unsupported.push(note("preview_not_owned", { path: preview.path, sourcePageId: preview.sourcePageId, unitId }))
        continue
      }
      operations.push(relationshipOperations.get(preview))
      compatibility.represented.push(note("original_preview", { path: preview.path, sourcePageId: preview.sourcePageId, unitId }))
    }
    const commandEdges = edges.map(({ evidenceRef: _evidence, ...edge }) => edge)
    const command = { idempotencyKey: remember(ledger.idempotencyKeys, unitId, () => `k${opaque()}`), artifactId: null, expectedRevisionId: null, expectedContentVersion: 0, files, pages: pagesOut, edges: commandEdges }
    const inventory = {
      version: 1,
      inventoryId: remember(ledger.inventoryIds, unitId, () => `inv${opaque()}`),
      selectionId: remember(ledger.selectionIds, unitId, () => `sel${opaque()}`),
      sourceInstance: input.sourceInstance,
      sourceArtifactId: unitId,
      approvalRef: input.approvalRef,
      kind: input.kind,
      command,
      pageMappings: list.filter(item => local.has(item.page.documentPath)).map(item => ({ sourcePageId: item.page.sourcePageId, pageId: item.pageId, documentPath: item.page.documentPath, route: routeOf(item.page.documentPath), ownershipEvidenceRef: item.page.ownershipEvidenceRef })).sort((left, right) => left.pageId < right.pageId ? -1 : 1),
      edgeEvidence: edges.map(edge => ({ ownerPageId: edge.ownerPageId, path: edge.path, providerArtifactId: edge.providerArtifactId, evidenceRef: edge.evidenceRef })),
      evidence: { selectionDigest: input.selectionDigest, corpusDigest: input.corpusDigest, mappingRef: input.mappingRef, capturedAt: input.capturedAt, complete: true, g1bRef: input.g1bRef },
      files: files.map(file => ({ path: file.path, kind: file.kind, contentType: file.contentType, size: file.size, sha256: file.sha256, sourceRef: `capture/${placed.get(file.path).entry.locator.root}/${placed.get(file.path).entry.locator.relative}`, sourceVersion: null, provenance: placed.get(file.path).entry.provenance })),
      operations,
    }
    const selection = { version: 1, inventoryId: inventory.inventoryId, selectionId: inventory.selectionId, planId: remember(ledger.planIds, unitId, () => `plan${opaque()}`), command }
    const missing = dependencies.some(item => item.state === "missing")
    const cost = staticBudgets.get(unitId) ?? budget(selection, utf8(stable(inventory)), input.limits)
    const unitEntries = entriesByUnit.get(unitId) ?? []
    const invalidMember = (selectedByUnit.get(unitId) ?? []).some(page => !pageState.has(page.sourcePageId) || entries.get(page.documentPath)?.placement?.sourceArtifactId !== unitId)
    const missingMember = unitEntries.some(entry => !placed.has(entry.path))
    const relationshipFailure = relationshipBlocked.has(unitId) || compatibility.unsupported.some(issue => issue.unitId === unitId)
    let status = input.targetBasis !== "empty" || missing || cost.failed.length || !pagesOut.length || invalidMember || missingMember || relationshipFailure ? "blocked" : "representable"
    if (invalidMember || missingMember) compatibility.unsupported.push(note("incomplete_source_artifact", { unitId }))
    if (input.targetBasis !== "empty") compatibility.unsupported.push(note("target_basis_unknown", { unitId }))
    if (cost.failed.length) compatibility.unsupported.push(note("budget_exceeded", { unitId, budget: cost }))
    if (status === "representable") compatibility.represented.push(note("publication_unit", { unitId }))
    for (const path of local) account(path, status === "representable" ? "placed" : "blocked", unitId, status)
    const sourceEvidence = {
      membership: (selectedByUnit.get(unitId) ?? []).map(page => ({ sourcePageId: page.sourcePageId, evidenceRef: page.membership.evidenceRef })),
      placement: unitEntries.map(entry => ({ path: entry.path, evidenceRef: entry.placement.evidenceRef })),
    }
    units.push({ unitId, status, pinState: status === "representable" ? "awaiting_source" : "blocked", blockers: status === "representable" ? [] : compatibility.unsupported.filter(item => item.unitId === unitId), budget: cost, dependencies, sourceEvidence, command: status === "representable" ? command : null, selection: status === "representable" ? selection : null, inventory: status === "representable" ? inventory : null, sourceArtifactId: inventory.sourceArtifactId, maxInventoryBytes: input.limits.maxInventoryBytes })
  }
  for (const [path, item] of placed) {
    if (assigned.has(path) || seen.has(path)) continue
    const code = item.entry.graphClass === "asset" && !(ownersByPath.get(path)?.length) ? "unowned_asset_unplaced" : "unplaced_path"
    compatibility.unsupported.push(note(code, { path }))
    account(path, "blocked", null, code)
  }
  for (const path of entries.keys()) if (!seen.has(path)) account(path, "blocked", null, "unaccounted_path")
  const consumerCensus = []
  const fatalConsumer = false
  for (const check of consumerChecks) {
    if (check.valid && !blockedUnits.has(check.unitId)) compatibility.represented.push(note("consumer_url_represented", { sourcePageId: check.page.sourcePageId, unitId: check.unitId }))
    else if (!check.valid) compatibility.unsupported.push(note(check.code, { unitId: check.unitId }))
    consumerCensus.push({ kind: "consumerUrl", ordinal: check.ordinal, unitId: check.unitId, disposition: check.valid ? "represented" : "rejected" })
  }
  for (const row of accounting) if (row.unitId === null && entries.get(row.path)?.placement) row.unitId = entries.get(row.path).placement.sourceArtifactId
  const unitStatuses = new Map(units.map(unit => [unit.unitId, unit.status]))
  const accountingByPath = new Map(accounting.map(row => [row.path, row]))
  const census = []
  for (let ordinal = 0; ordinal < input.entries.length; ordinal++) {
    const entry = input.entries[ordinal]
    const result = accountingByPath.get(entry.path)
    census.push({ kind: "entry", ordinal, unitId: result?.unitId ?? null, disposition: result?.disposition === "excluded" ? "excluded" : result?.disposition === "placed" ? "represented" : "rejected" })
  }
  for (let ordinal = 0; ordinal < input.pages.length; ordinal++) {
    const unitId = input.pages[ordinal].membership.sourceArtifactId
    census.push({ kind: "page", ordinal, unitId, disposition: unitStatuses.get(unitId) === "representable" ? "represented" : "rejected" })
  }
  for (const row of relationshipCensus) census.push({ ...row, disposition: row.disposition === "pending" && unitStatuses.get(row.unitId) === "representable" ? "represented" : "rejected" })
  for (let ordinal = 0; ordinal < input.exclusions.length; ordinal++) {
    const result = accountingByPath.get(input.exclusions[ordinal].path)
    census.push({ kind: "exclusion", ordinal, unitId: null, disposition: result?.disposition === "excluded" ? "represented" : "rejected" })
  }
  for (let ordinal = 0; ordinal < input.providerMounts.length; ordinal++) census.push({ kind: "providerMount", ordinal, unitId: null, disposition: "rejected" })
  for (const row of consumerCensus) census.push({ ...row, disposition: row.disposition === "represented" && unitStatuses.get(row.unitId) === "representable" ? "represented" : "rejected" })
  accounting.sort((left, right) => left.path < right.path ? -1 : 1)
  return { ok: !fatalConsumer && !unassignable && accounting.every(row => row.disposition !== "blocked") && compatibility.unsupported.length === 0, fatal: fatalConsumer || unassignable ? "unassignable_record" : null, schema: SELECTED_IMPORT_SCHEMA, kind: input.kind, sourceInstance: input.sourceInstance, targetBasis: input.targetBasis, ledger, accounting, census, units, compatibility, warnings, approvalRef: input.approvalRef, g1bRef: input.g1bRef }
  } }
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
