import * as csstree from "css-tree"

interface Namespace {
  pageId: string
  revisionId: string
  canonicalHost: string
  aliasHosts: readonly string[]
  shellPaths: readonly string[]
  shareContext: { readonly canonicalPrefix: string; readonly sharePrefix: string } | null
}

export interface HtmlRewriteOptions extends Namespace {
  /** The original, absolute document URL, before revision pinning. */
  documentUrl: string
  /** Management destination for a navigable page, never a share URL. */
  managementUrl: string | null
}

export interface CssRewriteOptions extends Namespace {
  /** The original, absolute URL of this stylesheet, not its pinned URL. */
  resourceUrl: string
}

function resourceUrl(value: string, base: URL, origin: string, namespace: Namespace): string {
  const trimmed = value.trim()
  // Fragment-only references can address an element in the current document or SVG.
  if (!trimmed || trimmed.startsWith("#")) return value
  let resolved: URL
  try {
    resolved = new URL(trimmed, base)
  } catch {
    return value
  }
  if (!localUrl(resolved, namespace)) return value
  const path = namespace.shellPaths.includes(resolved.pathname)
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : `/_revisions/${namespace.pageId}/${namespace.revisionId}${resolved.pathname}${resolved.search}${resolved.hash}`
  return base.origin === origin && !path.startsWith("//") ? path : `${origin}${path}`
}

function localUrl(url: URL, namespace: Namespace): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && !url.port &&
    (url.hostname === namespace.canonicalHost || namespace.aliasHosts.includes(url.hostname))
}

function rewriteCssText(text: string, base: URL, origin: string, namespace: Namespace, context: "stylesheet" | "declarationList"): string {
  const ast = csstree.parse(text, { context, parseCustomProperty: true })
  csstree.walk(ast, (node) => {
    if (node.type === "Url") {
      node.value = resourceUrl(node.value, base, origin, namespace)
    } else if (node.type === "Atrule" && node.name.toLowerCase() === "charset") {
      if (node.prelude?.type === "Raw") node.prelude.value = '"utf-8"'
      else if (node.prelude?.type === "AtrulePrelude") {
        const first = node.prelude.children.first
        if (first?.type === "String") first.value = "utf-8"
      }
    } else if (node.type === "Atrule" && node.name.toLowerCase() === "import" && node.prelude?.type === "AtrulePrelude") {
      const first = node.prelude.children.first
      if (first?.type === "String") first.value = resourceUrl(first.value, base, origin, namespace)
    } else if (node.type === "Function" && ["image-set", "-webkit-image-set"].includes(node.name.toLowerCase())) {
      node.children.forEach((child) => {
        if (child.type === "String") child.value = resourceUrl(child.value, base, origin, namespace)
      })
    }
  })
  return csstree.generate(ast)
}

// Follow the srcset tokenization rules: commas inside a URL (notably data URLs)
// are not candidate separators; trailing commas after a URL are separators.
function rewriteSrcset(value: string, base: URL, origin: string, namespace: Namespace): string {
  let result = ""
  let position = 0
  while (position < value.length) {
    const start = position
    while (position < value.length && (value[position] === "," || /\s/.test(value[position]))) position++
    result += value.slice(start, position)
    const urlStart = position
    while (position < value.length && !/\s/.test(value[position])) position++
    let urlEnd = position
    while (urlEnd > urlStart && value[urlEnd - 1] === ",") urlEnd--
    result += resourceUrl(value.slice(urlStart, urlEnd), base, origin, namespace)
    result += value.slice(urlEnd, position)
    if (urlEnd !== position) continue
    const descriptorStart = position
    let parentheses = 0
    while (position < value.length) {
      const char = value[position++]
      if (char === "(") parentheses++
      else if (char === ")" && parentheses > 0) parentheses--
      else if (char === "," && parentheses === 0) break
    }
    result += value.slice(descriptorStart, position)
  }
  return result
}

// Preserve the original parameter text; semicolons inside quoted strings are
// data, and quoted-pair escapes do not end a quoted string.
function mediaTypeParts(type: string): string[] {
  const parts: string[] = []
  let start = 0, quoted = false, escaped = false
  for (let i = 0; i < type.length; i++) {
    const char = type[i]
    if (quoted && escaped) { escaped = false; continue }
    if (quoted && char === "\\") { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (char === ";" && !quoted) { parts.push(type.slice(start, i)); start = i + 1 }
  }
  parts.push(type.slice(start))
  return parts
}

function charsetParameter(part: string): string | undefined {
  const match = /^\s*charset\s*=\s*(?:"((?:\\[\t -~]|[^"\\])*)"|([^\s;]+))\s*$/i.exec(part)
  return match ? (match[1] === undefined ? match[2] : match[1].replace(/\\([\t -~])/g, "$1")) : undefined
}

function mediaTypeCharset(type: string): string | undefined {
  for (const part of mediaTypeParts(type).slice(1)) {
    const charset = charsetParameter(part)
    if (charset !== undefined) return charset
  }
  return undefined
}

async function htmlEncoding(prefix: string): Promise<string | undefined> {
  let label: string | undefined
  await new HTMLRewriter().on("meta", {
    element(element) {
      if (label) return
      let candidate = element.getAttribute("charset")
      if (!candidate && element.getAttribute("http-equiv")?.trim().toLowerCase() === "content-type") {
        candidate = mediaTypeCharset(element.getAttribute("content") ?? "") ?? null
      }
      if (!candidate) return
      try { label = new TextDecoder(candidate.trim()).encoding } catch { /* Continue to the next declaration. */ }
    },
  }).transform(new Response(prefix)).text()
  return label
}

async function decodedText(response: Response, kind: "html" | "css"): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  const type = response.headers.get("content-type") ?? ""
  let label = mediaTypeCharset(type)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = "utf-8"
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le"
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be"
  if (!label) {
    const prefix = new TextDecoder("windows-1252").decode(bytes.subarray(0, 1024))
    label = kind === "css"
      ? /^@charset\s+["']([^"']+)["'];/i.exec(prefix)?.[1]
      : await htmlEncoding(prefix)
  }
  return new TextDecoder(label ?? "utf-8", { fatal: true }).decode(bytes)
}

export function transformedContentType(type: string): string {
  const parts = mediaTypeParts(type)
  return `${parts[0]}${parts.slice(1).filter(part => charsetParameter(part) === undefined).map(part => `;${part}`).join("")}; charset=utf-8`
}

function transformedHeaders(response: Response): Headers {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("etag")
  headers.delete("content-md5")
  const type = headers.get("content-type")
  if (type) headers.set("content-type", transformedContentType(type))
  return headers
}

/** Rewrite a stylesheet against its original URL while retaining the requesting revision namespace. */
export async function rewriteCss(response: Response, options: CssRewriteOptions): Promise<Response> {
  const base = new URL(options.resourceUrl)
  const body = rewriteCssText(await decodedText(response, "css"), base, base.origin, options, "stylesheet")
  return new Response(body, { status: response.status, statusText: response.statusText, headers: transformedHeaders(response) })
}

/** Rewrite resource references without rewriting navigation or executable script text. */
export async function rewriteHtml(response: Response, options: HtmlRewriteOptions): Promise<Response> {
  const documentUrl = new URL(options.documentUrl)
  const originalHtml = await decodedText(response, "html")
  // Match the shipped legacy script by its complete bytes, not marker mentions
  // in unrelated application scripts.
  const scripts: { text: string; external: boolean }[] = []
  await new HTMLRewriter().on("script", {
    element(element) { scripts.push({ text: "", external: element.hasAttribute("src") }) },
    text(text) { scripts[scripts.length - 1].text += text.text },
  }).transform(new Response(originalHtml)).text()
  const removedScripts = new Set<number>()
  for (let i = 1; i < scripts.length; i++) {
    if (scripts[i].external || scripts[i - 1].external || !scripts[i].text.trim().startsWith("/* forge share-bar")) continue
    const config = /^\s*window\.__FORGE_SHARE__\s*=\s*(\{[\s\S]*\})\s*;\s*$/.exec(scripts[i - 1].text)
    if (!config) continue
    try {
      const parsed: unknown = JSON.parse(config[1])
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scripts[i].text.trim())))
      const hex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
      if (hex === "bbf3cc434d129969f2231d2b3f232b589f81e81e730ceefdd7e96d07c345df28") {
        removedScripts.add(i - 1)
        removedScripts.add(i)
      }
    } catch { /* Not a legacy configuration. */ }
  }
  let insideLegacyBar = false
  let scriptIndex = 0
  const cleanup = new HTMLRewriter()
    .onDocument({
      comments(comment) {
        const marker = comment.text.trim().toLowerCase()
        if (marker === "forge-share-bar") { insideLegacyBar = true; comment.remove() }
        else if (marker === "/forge-share-bar") { insideLegacyBar = false; comment.remove() }
        else if (insideLegacyBar) comment.remove()
      },
    })
    .on("*", { element(element) { if (insideLegacyBar || element.hasAttribute("data-forge-share-bar") || element.hasAttribute("data-forge-toast")) element.remove() } })
    .on("script", { element(element) { if (removedScripts.has(scriptIndex++)) element.remove() } })
  const html = await cleanup.transform(new Response(originalHtml)).text()
  let base = documentUrl
  let foundBase = false
  // Base applies to the entire document, including elements preceding <base>.
  await new HTMLRewriter().on("base[href]", {
    element(element) {
      if (foundBase) return
      foundBase = true
      try { base = new URL(element.getAttribute("href")!, documentUrl) } catch { /* Invalid base uses the document URL. */ }
    },
  }).transform(new Response(html)).text()

  const rewriter = new HTMLRewriter()
  if (options.managementUrl) {
    const url = options.managementUrl.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
    let appended = false
    const link = `<aside data-forge-management><a href="${url}" target="_blank" rel="noopener noreferrer">Manage this page</a></aside>`
    rewriter.on("body", { element(element) { element.append(link, { html: true }); appended = true } })
    rewriter.onDocument({ end(end) { if (!appended) end.append(link, { html: true }) } })
  }
  rewriter.on("meta[charset], meta[http-equiv]", {
    element(element) {
      if (element.hasAttribute("charset")) element.setAttribute("charset", "utf-8")
      if (element.getAttribute("http-equiv")?.toLowerCase() === "content-type") {
        const content = element.getAttribute("content")
        if (content) element.setAttribute("content", transformedContentType(content))
      }
    },
  })
  rewriter.on("base[href]", {
    element(element) {
      const href = element.getAttribute("href")!
      try { element.setAttribute("href", new URL(href, documentUrl).href) } catch { /* Preserve invalid bases. */ }
    },
  })
  rewriter.on("a[href], area[href]", {
    element(element) {
      const href = element.getAttribute("href")!
      if (!href.trim() || href.trim().startsWith("#")) return
      try {
        const target = new URL(href, base)
        if (localUrl(target, options)) {
          const context = options.shareContext
          const path = context && target.pathname.startsWith(context.canonicalPrefix)
            ? context.sharePrefix + target.pathname.slice(context.canonicalPrefix.length)
            : target.pathname
          const suffix = `${path}${target.search}${target.hash}`
          const origin = context && path !== target.pathname ? documentUrl.origin : target.origin
          element.setAttribute("href", base.origin === origin && !suffix.startsWith("//") ? suffix : `${origin}${suffix}`)
        }
      } catch { /* Preserve invalid navigation URLs. */ }
    },
  })
  rewriter.on("use, image", {
    element(element) {
      for (const name of ["href", "xlink:href"]) {
        const value = element.getAttribute(name)
        if (value !== null) element.setAttribute(name, resourceUrl(value, base, documentUrl.origin, options))
      }
    },
  })
  rewriter.on("[src], [poster], [data], link[href], [srcset], link[imagesrcset], [style]", {
    element(element) {
      const tag = element.tagName.toLowerCase()
      const attributes: string[] = []
      if (element.hasAttribute("src") && tag !== "input") attributes.push("src")
      if (tag === "input" && element.getAttribute("type")?.toLowerCase() === "image") attributes.push("src")
      if (tag === "video") attributes.push("poster")
      if (tag === "object") attributes.push("data")
      if (tag === "link") {
        const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/)
        if (rel.includes("stylesheet") || (rel.includes("preload") && element.getAttribute("as")?.toLowerCase() === "style")) {
          const href = element.getAttribute("href")
          try {
            const target = href === null ? null : new URL(href, base)
            if (target && localUrl(target, options) && !options.shellPaths.includes(target.pathname)) element.removeAttribute("integrity")
          } catch { /* Preserve assertions for invalid or external URLs. */ }
        }
        if (rel.some((token) => ["stylesheet", "icon", "preload", "modulepreload", "prefetch", "manifest"].includes(token))) attributes.push("href")
      }
      for (const name of attributes) {
        const value = element.getAttribute(name)
        if (value !== null) element.setAttribute(name, resourceUrl(value, base, documentUrl.origin, options))
      }
      for (const name of ["srcset", "imagesrcset"]) {
        const value = element.getAttribute(name)
        if (value !== null) element.setAttribute(name, rewriteSrcset(value, base, documentUrl.origin, options))
      }
      const style = element.getAttribute("style")
      if (style !== null) element.setAttribute("style", rewriteCssText(style, base, documentUrl.origin, options, "declarationList"))
    },
  })
  let styleText = ""
  rewriter.on("style", {
    element() { styleText = "" },
    text(text) {
      styleText += text.text
      if (text.lastInTextNode) {
        const css = rewriteCssText(styleText, base, documentUrl.origin, options, "stylesheet")
        // CSS escaping keeps the token value while preventing HTML's raw-text
        // parser from interpreting generated text as a closing style tag.
        text.replace(css.replace(/<(?=\/style(?:[\t\n\f\r />]|$))/gi, "\\3c "), { html: true })
        styleText = ""
      } else {
        text.remove()
      }
    },
  })
  return rewriter.transform(new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers: transformedHeaders(response),
  }))
}
