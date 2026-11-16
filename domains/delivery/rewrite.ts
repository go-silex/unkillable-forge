import * as csstree from "css-tree"

interface Namespace {
  pageId: string
  revisionId: string
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
  if ((resolved.protocol !== "http:" && resolved.protocol !== "https:") || resolved.origin !== origin) return value
  return `/_revisions/${namespace.pageId}/${namespace.revisionId}${resolved.pathname}${resolved.search}${resolved.hash}`
}

function rewriteCssText(text: string, base: URL, origin: string, namespace: Namespace, context: "stylesheet" | "declarationList"): string {
  const ast = csstree.parse(text, { context, parseCustomProperty: true })
  csstree.walk(ast, (node) => {
    if (node.type === "Url") {
      node.value = resourceUrl(node.value, base, origin, namespace)
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

function transformedHeaders(response: Response): Headers {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("etag")
  headers.delete("content-md5")
  return headers
}

/** Rewrite a stylesheet against its original URL while retaining the requesting revision namespace. */
export async function rewriteCss(response: Response, options: CssRewriteOptions): Promise<Response> {
  const base = new URL(options.resourceUrl)
  const body = rewriteCssText(await response.text(), base, base.origin, options, "stylesheet")
  return new Response(body, { status: response.status, statusText: response.statusText, headers: transformedHeaders(response) })
}

/** Rewrite resource references without rewriting navigation or executable script text. */
export async function rewriteHtml(response: Response, options: HtmlRewriteOptions): Promise<Response> {
  const documentUrl = new URL(options.documentUrl)
  const originalHtml = await response.text()
  let insideLegacyBar = false
  let scriptText = ""
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
    .on("script", {
      element() { scriptText = "" },
      text(text) {
        scriptText += text.text
        if (!text.lastInTextNode) { text.remove(); return }
        if (insideLegacyBar || scriptText.includes("__FORGE_SHARE__") || scriptText.includes("__FORGE_SHARE_BAR__")) text.remove()
        else text.replace(scriptText, { html: true })
        scriptText = ""
      },
    })
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
        if (target.origin === documentUrl.origin && (target.protocol === "http:" || target.protocol === "https:")) {
          element.setAttribute("href", `${target.pathname}${target.search}${target.hash}`)
        }
      } catch { /* Preserve invalid navigation URLs. */ }
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
        text.replace(rewriteCssText(styleText, base, documentUrl.origin, options, "stylesheet"), { html: true })
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
