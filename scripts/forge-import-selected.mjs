// Translate one explicit operator selection into ordinary BeginCommand,
// ImportSelection and inventory drafts. This module does not open files,
// discover captures, decide access, or contact a provider. Native R2 versions
// are filled only by assignSourcePins after a real local PUT.

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
  if (typeof map[key] !== "string") map[key] = mint()
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
function directoryOf(path) {
  const cut = path.lastIndexOf("/")
  return cut <= 0 ? "/" : path.slice(0, cut + 1)
}
function unionFind(ids) {
  const parent = new Map(ids.map(id => [id, id]))
  const find = id => {
    let current = id
    while (parent.get(current) !== current) current = parent.get(current)
    let cursor = id
    while (cursor !== current) {
      const next = parent.get(cursor)
      parent.set(cursor, current)
      cursor = next
    }
    return current
  }
  return { find, join(left, right) { const a = find(left); const b = find(right); if (a !== b) parent.set(b, a) } }
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
  const keys = ["version", "kind", "sourceInstance", "selectionRef", "approvalRef", "g1bRef", "capturedAt", "corpusDigest", "selectionDigest", "mappingRef", "complete", "targetBasis", "limits", "grammar", "shellPaths", "captureRoots", "entries", "pages", "owners", "aliases", "shortlinks", "previews", "consumerUrls", "exclusions", "providerMounts"]
  if (!exact(input, keys) || input.version !== 1 || !one(input.kind, ["synthetic", "historical"]) || !text(input.sourceInstance) || !text(input.selectionRef) || !text(input.approvalRef) || !integer(input.capturedAt) || input.capturedAt < 0 || !hex(input.corpusDigest) || !hex(input.selectionDigest) || !text(input.mappingRef) || input.complete !== true || !one(input.targetBasis, ["empty", "unknown"])) return "invalid_selection"
  if (input.kind === "historical" ? !text(input.g1bRef) : input.g1bRef !== null) return "g1b_evidence_required"
  const limits = input.limits
  if (!exact(limits, ["maxCommandBytes", "maxJsonDepth", "maxUploadBytes", "maxInventoryBytes"]) || [limits.maxCommandBytes, limits.maxUploadBytes, limits.maxInventoryBytes].some(item => !integer(item) || item <= 0) || !integer(limits.maxJsonDepth) || limits.maxJsonDepth < 1 || limits.maxJsonDepth > 64) return "invalid_limits"
  const grammar = input.grammar
  if (!exact(grammar, ["routeGrammars", "shareGrammars"]) || !Array.isArray(grammar.routeGrammars) || !Array.isArray(grammar.shareGrammars) || grammar.routeGrammars.length === 0 || grammar.routeGrammars.some(item => item !== "tree" && item !== "subtree") || grammar.shareGrammars.some(item => item !== "slug" && item !== "page" && item !== "card")) return "invalid_grammar"
  if (["shellPaths", "captureRoots", "entries", "pages", "owners", "aliases", "shortlinks", "previews", "consumerUrls", "exclusions", "providerMounts"].some(key => !Array.isArray(input[key]))) return "invalid_selection"
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
function consumerIssue(url, grammar) {
  let parsed
  try { parsed = new URL(url) } catch { return "consumer_url_invalid" }
  if (parsed.searchParams.has("k") && parsed.searchParams.get("k") === "") return "empty_query_key_invalid"
  const parts = parsed.pathname.split("/").filter(Boolean)
  if (parts[0] !== "s") return null
  const key = parts.at(-1) ?? ""
  const identity = parts.slice(1, -1).join("/")
  const both = grammar.routeGrammars.includes("tree") && grammar.routeGrammars.includes("subtree")
  if (both && parts.length >= 3 && SHARE_KEY.test(key) && /(?:^|\/)og\.(?:jpe?g|png)$/.test(identity) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identity.slice(0, identity.lastIndexOf("/")))) return "two_candidate_card"
  if (parsed.searchParams.get("k") !== null && identity.includes(".html")) return "tree_query_share_unsupported"
  return null
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

export async function translateSelection(input, ledgerInput = null, observations = {}) {
  const compatibility = { represented: [], unsupported: [], notObserved: [] }
  const warnings = []
  const accounting = []
  const seen = new Set()
  const account = (path, disposition, unitId, reason) => {
    if (!path || seen.has(path)) return
    seen.add(path)
    accounting.push({ path, disposition, unitId, reason })
  }
  const fatal = header(input)
  const ledger = ledgerOf(ledgerInput)
  if (fatal || !ledger) {
    return { ok: false, schema: SELECTED_IMPORT_SCHEMA, ledger: ledger ?? emptyLedger(), accounting, units: [], compatibility: { represented: [], unsupported: [note(fatal ?? "invalid_ledger")], notObserved: [] }, warnings }
  }
  const roots = new Set(input.captureRoots)
  const shells = new Set(input.shellPaths.filter(path => typeof path === "string"))
  const entries = new Map()
  let contradictory = false
  for (const entry of input.entries) {
    const path = record(entry) && typeof entry.path === "string" ? entry.path : undefined
    const nonContent = one(entry?.graphClass, ["shell", "excluded", "unresolved"])
    const validFingerprint = exact(entry?.expected, ["size", "sha256"]) && integer(entry.expected.size) && entry.expected.size >= 0 && hex(entry.expected.sha256)
    if (!exact(entry, ["path", "graphClass", "locator", "contentType", "provenance", "expected"]) || !validPath(entry.path, nonContent) || !one(entry.graphClass, ["page_document", "subdocument", "fragment", "asset", "shell", "excluded", "unresolved"]) || !exact(entry.locator, ["root", "relative"]) || !(validFingerprint || (nonContent && entry.expected === null)) || !text(entry.provenance) || !(entry.contentType === null || text(entry.contentType, 255))) {
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
    return { ok: false, schema: SELECTED_IMPORT_SCHEMA, ledger, accounting, units: [], compatibility, warnings, sourceInstance: input.sourceInstance, kind: input.kind }
  }
  const placed = new Map()
  const pages = []
  for (const page of input.pages) {
    if (!exact(page, ["sourcePageId", "documentPath", "metadata", "ownershipEvidenceRef", "visibility", "share"]) || !text(page.sourcePageId) || !validPath(page.documentPath) || !text(page.ownershipEvidenceRef) || ENGINE_ID.test(page.sourcePageId)) {
      compatibility.unsupported.push(note("contradictory_page"))
      continue
    }
    const visibility = capture(page.visibility, "visibility")
    const share = capture(page.share, "share")
    if (!visibility || !share || (page.metadata !== null && !record(page.metadata))) {
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
  for (const entry of entries.values()) {
    const path = entry.path
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
    let metadataBytes = LIMITS.fileBytes
    try { metadataBytes = utf8(stable(page.metadata)) } catch { metadataBytes = LIMITS.fileBytes }
    if (metadataBytes > 8192) {
      compatibility.unsupported.push(note("metadata_too_large", { path: page.documentPath, sourcePageId: page.sourcePageId }))
      placed.delete(page.documentPath)
      account(page.documentPath, "blocked", null, "metadata_too_large")
      continue
    }
    const visibility = page.visibility
    const share = page.share
    if (visibility.state === "unreadable" || share.state === "unreadable" && visibility.state === "present" && visibility.value === "shared") {
      const code = visibility.state === "unreadable" ? "visibility_unreadable" : "share_key_unreadable"
      compatibility.unsupported.push(note(code, { path: page.documentPath, sourcePageId: page.sourcePageId }))
      compatibility.notObserved.push(note(code, { sourcePageId: page.sourcePageId }))
      placed.delete(page.documentPath)
      account(page.documentPath, "blocked", null, code)
      continue
    }
    let visibilityValue = null
    if (visibility.state === "unknown") {
      warnings.push(note("unknown_visibility_private", { sourcePageId: page.sourcePageId }))
      compatibility.notObserved.push(note("unknown_visibility_private", { sourcePageId: page.sourcePageId }))
    } else if (visibility.state === "absent") compatibility.represented.push(note("visibility_absent_private", { sourcePageId: page.sourcePageId }))
    else if (visibility.metadataV !== null && visibility.metadataV !== visibility.value) {
      compatibility.unsupported.push(note("visibility_metadata_mismatch", { sourcePageId: page.sourcePageId, path: page.documentPath }))
      placed.delete(page.documentPath)
      account(page.documentPath, "blocked", null, "visibility_metadata_mismatch")
      continue
    } else if (visibility.value !== null && !["private", "public", "shared"].includes(visibility.value)) {
      warnings.push(note("unknown_visibility_private", { sourcePageId: page.sourcePageId }))
      compatibility.notObserved.push(note("unknown_visibility_private", { sourcePageId: page.sourcePageId }))
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
    } else if (share.state === "present" && share.key !== null) compatibility.unsupported.push(note("share_key_not_imported", { sourcePageId: page.sourcePageId }))
    else if (share.state === "unknown" || share.state === "unreadable") compatibility.notObserved.push(note(share.state === "unknown" ? "share_unknown" : "share_unreadable", { sourcePageId: page.sourcePageId }))
    pageState.set(page.sourcePageId, {
      page, pageId: remember(ledger.pages, page.sourcePageId, () => engineId("pg")),
      grantId: shareKey ? remember(ledger.grants, page.sourcePageId, () => engineId("gr")) : null,
      visibilityValue, shareKey, metadataV: visibility.state === "present" && visibility.metadataV === visibilityValue ? visibility.metadataV : null,
    })
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
  const livePages = [...pageState.values()].filter(item => placed.has(item.page.documentPath))
  const components = unionFind(livePages.map(item => item.page.sourcePageId))
  for (const page of livePages) {
    const slug = slugOf(page.page.documentPath)
    if (slug) for (const other of livePages) if (slugOf(other.page.documentPath) === slug) components.join(page.page.sourcePageId, other.page.sourcePageId)
  }
  for (const [path, list] of ownersByPath) {
    if (!placed.has(path)) continue
    const live = list.map(owner => owner.ownerSourcePageId).filter(source => pageState.has(source) && placed.has(pageState.get(source).page.documentPath))
    for (const source of live.slice(1)) components.join(live[0], source)
  }
  const groups = new Map()
  for (const page of livePages) {
    const root = components.find(page.page.sourcePageId)
    const members = livePages.filter(item => components.find(item.page.sourcePageId) === root)
    const slugs = new Set(members.map(item => slugOf(item.page.documentPath)))
    const unitId = slugs.size === 1 && [...slugs][0] ? `slug:${[...slugs][0]}` : `tree:${members.map(item => item.page.sourcePageId).sort().join("+")}`
    const list = groups.get(unitId) ?? []
    if (!list.some(item => item.page.sourcePageId === page.page.sourcePageId)) list.push(page)
    groups.set(unitId, list)
  }
  for (const [unitId, list] of [...groups]) {
    if (!unitId.startsWith("slug:")) continue
    const slug = unitId.slice(5)
    if (!list.some(item => item.page.documentPath === `/a/${slug}/index.html`)) {
      compatibility.unsupported.push(note("missing_slug_root", { unitId }))
      for (const item of list) {
        placed.delete(item.page.documentPath)
        account(item.page.documentPath, "blocked", unitId, "missing_slug_root")
      }
      groups.delete(unitId)
    }
  }
  const mounts = new Map()
  for (const mount of input.providerMounts) {
    if (!exact(mount, ["artifactId", "path", "kind"]) || !ENGINE_ID.test(mount.artifactId) || !mount.artifactId.startsWith("ar_") || !validPath(mount.path) || !one(mount.kind, ["fragment", "asset"])) {
      compatibility.unsupported.push(note("invalid_provider_mount"))
      continue
    }
    mounts.set(mount.path, mount)
  }
  const assigned = new Set()
  const units = []
  const directories = new Map()
  for (const [unitId, list] of groups) for (const page of list) directories.set(page.page.documentPath, { unitId, directory: directoryOf(page.page.documentPath) })
  for (const [unitId, list] of [...groups].sort(([left], [right]) => left < right ? -1 : 1)) {
    const sources = new Set(list.map(item => item.page.sourcePageId))
    const local = new Set()
    const edges = []
    const dependencies = []
    const memberSlugs = new Set(list.map(item => slugOf(item.page.documentPath)).filter(Boolean))
    for (const item of list) if (placed.has(item.page.documentPath)) local.add(item.page.documentPath)
    for (const [path, item] of placed) {
      if (local.has(path) || item.entry.graphClass === "page_document") continue
      const ownedHere = (ownersByPath.get(path) ?? []).filter(owner => sources.has(owner.ownerSourcePageId))
      const ownedElsewhere = (ownersByPath.get(path) ?? []).some(owner => pageState.has(owner.ownerSourcePageId) && !sources.has(owner.ownerSourcePageId))
      if (ownedHere.length && !ownedElsewhere) local.add(path)
      else if (!ownedHere.length && !ownedElsewhere && memberSlugs.has(slugOf(path))) local.add(path)
    }
    for (const [path, item] of placed) {
      if (assigned.has(path) || local.has(path) || item.entry.graphClass === "page_document") continue
      if ((ownersByPath.get(path) ?? []).some(owner => pageState.has(owner.ownerSourcePageId))) continue
      if (slugOf(path)) continue
      const matches = [...directories].filter(([, row]) => path.startsWith(row.directory)).sort((left, right) => right[1].directory.length - left[1].directory.length)
      const best = matches[0]
      const tied = matches.filter(row => row[1].directory.length === best?.[1].directory.length)
      if (best && tied.length === 1 && tied[0][1].unitId === unitId) {
        local.add(path)
        compatibility.represented.push(note("unowned_asset_placed", { path, unitId }))
      }
    }
    for (const path of local) assigned.add(path)
    const files = [...local].sort().map(path => {
      const item = placed.get(path)
      return { path, kind: item.entry.graphClass === "page_document" ? "document" : item.entry.graphClass, sha256: item.observed.sha256, size: item.observed.size, contentType: item.entry.contentType, source: "client" }
    })
    for (const [path, listOwners] of ownersByPath) {
      for (const owner of listOwners) {
        if (!sources.has(owner.ownerSourcePageId) || !pageState.has(owner.ownerSourcePageId)) continue
        const mount = mounts.get(path)
        if (local.has(path)) edges.push({ ownerPageId: pageState.get(owner.ownerSourcePageId).pageId, path, providerArtifactId: null, evidenceRef: owner.evidenceRef })
        else if (mount && (mount.kind === "fragment" || mount.kind === "asset")) {
          edges.push({ ownerPageId: pageState.get(owner.ownerSourcePageId).pageId, path, providerArtifactId: mount.artifactId, evidenceRef: owner.evidenceRef })
          dependencies.push({ path, providerArtifactId: mount.artifactId, state: "active" })
        } else {
          dependencies.push({ path, providerArtifactId: null, state: "missing" })
          compatibility.unsupported.push(note("provider_mount_required", { path, unitId }))
        }
      }
    }
    const pagesOut = list.filter(item => local.has(item.page.documentPath)).map(item => ({ pageId: item.pageId, disposition: "new", documentPath: item.page.documentPath, metadata: item.page.metadata, expectedPolicyEpoch: null })).sort((left, right) => left.pageId < right.pageId ? -1 : 1)
    const operations = []
    for (const item of list) {
      if (!local.has(item.page.documentPath)) continue
      operations.push({ kind: "page_policy", policy: { operationId: remember(ledger.operationIds, `policy:${item.page.sourcePageId}`, () => `op${opaque()}`), sourcePageId: item.page.sourcePageId, pageId: item.pageId, expectedPolicyEpoch: null, grantId: item.grantId, visibility: { captured: true, value: item.visibilityValue, metadataV: item.metadataV, expiresAt: null }, share: { captured: true, key: item.shareKey, expiresAt: null } } })
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
      operations.push({ kind: "alias", operationId: remember(ledger.operationIds, `alias:${alias.path}`, () => `op${opaque()}`), aliasKind: alias.aliasKind, path: alias.path, to: alias.to, status: alias.status, targetPageId: pageState.get(alias.targetSourcePageId).pageId })
      compatibility.represented.push(note("alias_team_fallback", { path: alias.path, unitId }))
    }
    for (const link of input.shortlinks) {
      if (!exact(link, ["mappingId", "providerOrigin", "providerId", "shortDomain", "shortCode", "shortUrl", "targetSourcePageId", "destination", "observedAt"]) || !sources.has(link.targetSourcePageId)) continue
      if (!text(link.mappingId) || !text(link.providerOrigin) || !(link.providerId === null || text(link.providerId)) || !text(link.shortDomain) || !text(link.shortCode) || !text(link.shortUrl) || !text(link.destination, 4096) || !integer(link.observedAt) || link.observedAt < 0 || !shortlinkIdentity(link)) {
        compatibility.unsupported.push(note("shortlink_invalid", { sourcePageId: link.targetSourcePageId, unitId }))
        continue
      }
      const page = pageState.get(link.targetSourcePageId)
      operations.push({ kind: "shortlink", operationId: remember(ledger.operationIds, `shortlink:${link.mappingId}`, () => `op${opaque()}`), mapping: { mappingId: link.mappingId, providerOrigin: link.providerOrigin, providerId: link.providerId, shortDomain: link.shortDomain, shortCode: link.shortCode, shortUrl: link.shortUrl, pageId: page.pageId, grantId: page.grantId, destination: link.destination, source: "imported", observedAt: link.observedAt, destinationDigest: await digest(link.destination) } })
      compatibility.represented.push(note("shortlink_exact_destination", { sourcePageId: link.targetSourcePageId, unitId }))
      try {
        const destination = new URL(link.destination)
        if (destination.searchParams.get("k") && /\/[^/]+\.html(?:\/|$)/.test(destination.pathname)) compatibility.unsupported.push(note("tree_query_share_unsupported", { sourcePageId: link.targetSourcePageId, unitId }))
      } catch { compatibility.unsupported.push(note("shortlink_invalid", { sourcePageId: link.targetSourcePageId, unitId })) }
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
      const file = files.find(item => item.path === preview.path)
      const page = pageState.get(preview.sourcePageId)
      const owned = file && ["image/jpeg", "image/png"].includes(file.contentType) && edges.some(edge => edge.ownerPageId === page.pageId && edge.path === preview.path && edge.providerArtifactId === null)
      if (!owned) {
        compatibility.unsupported.push(note("preview_not_owned", { path: preview.path, sourcePageId: preview.sourcePageId, unitId }))
        continue
      }
      operations.push({ kind: "preview_selection", operationId: remember(ledger.operationIds, `preview:${preview.sourcePageId}:${preview.path}`, () => `op${opaque()}`), pageId: page.pageId, path: preview.path })
      compatibility.represented.push(note("original_preview", { path: preview.path, sourcePageId: preview.sourcePageId, unitId }))
    }
    const commandEdges = edges.map(({ evidenceRef: _evidence, ...edge }) => edge)
    const command = { idempotencyKey: remember(ledger.idempotencyKeys, unitId, () => `k${opaque()}`), artifactId: null, expectedRevisionId: null, expectedContentVersion: 0, files, pages: pagesOut, edges: commandEdges }
    const inventory = {
      version: 1,
      inventoryId: remember(ledger.inventoryIds, unitId, () => `inv${opaque()}`),
      selectionId: remember(ledger.selectionIds, unitId, () => `sel${opaque()}`),
      sourceInstance: input.sourceInstance,
      sourceArtifactId: remember(ledger.sourceArtifacts, unitId, () => `sa_${opaque()}`),
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
    const cost = budget(selection, utf8(stable(inventory)), input.limits)
    let status = input.targetBasis !== "empty" || missing || cost.failed.length || !pagesOut.length ? "blocked" : "representable"
    if (input.targetBasis !== "empty") compatibility.unsupported.push(note("target_basis_unknown", { unitId }))
    if (cost.failed.length) compatibility.unsupported.push(note("budget_exceeded", { unitId, budget: cost }))
    if (status === "representable") compatibility.represented.push(note("publication_unit", { unitId }))
    for (const path of local) account(path, status === "representable" ? "placed" : "blocked", unitId, status)
    units.push({ unitId, status, pinState: status === "representable" ? "awaiting_source" : "blocked", blockers: status === "representable" ? [] : compatibility.unsupported.filter(item => item.unitId === unitId), budget: cost, dependencies, command: status === "representable" ? command : null, selection: status === "representable" ? selection : null, inventory: status === "representable" ? inventory : null, sourceArtifactId: inventory.sourceArtifactId, maxInventoryBytes: input.limits.maxInventoryBytes })
  }
  for (const [path, item] of placed) {
    if (assigned.has(path) || seen.has(path)) continue
    const code = item.entry.graphClass === "asset" && !(ownersByPath.get(path)?.length) ? "unowned_asset_unplaced" : "unplaced_path"
    compatibility.unsupported.push(note(code, { path }))
    account(path, "blocked", null, code)
  }
  for (const path of entries.keys()) if (!seen.has(path)) account(path, "blocked", null, "unaccounted_path")
  for (const url of input.consumerUrls) {
    if (!exact(url, ["url", "purpose"]) || typeof url.url !== "string" || !one(url.purpose, ["share", "card", "alias", "shortlink", "document"])) {
      compatibility.unsupported.push(note("contradictory_consumer_url"))
      continue
    }
    const code = consumerIssue(url.url, input.grammar)
    if (code) compatibility.unsupported.push(note(code))
    else compatibility.represented.push(note("consumer_url_represented"))
  }
  accounting.sort((left, right) => left.path < right.path ? -1 : 1)
  return { ok: accounting.every(row => row.disposition !== "blocked") && compatibility.unsupported.length === 0, schema: SELECTED_IMPORT_SCHEMA, kind: input.kind, sourceInstance: input.sourceInstance, targetBasis: input.targetBasis, ledger, accounting, units, compatibility, warnings, approvalRef: input.approvalRef, g1bRef: input.g1bRef }
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
