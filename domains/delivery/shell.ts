import { securityHeaders } from './serve'

export type ShellAsset = { readonly body: string | ArrayBuffer; readonly contentType: string }
export type FixedShellAssets = Readonly<Record<string, ShellAsset>>

const dynamicPaths: Readonly<Record<string, true>> = { '/': true, '/index.html': true, '/login': true, '/login.html': true }

/** Validate the complete instance bundle at composition, before serving requests. */
export function validateShellAssets(shellPaths: readonly string[], files: FixedShellAssets): boolean {
  const configured = new Set(shellPaths.filter(path => !Object.hasOwn(dynamicPaths, path)))
  const paths = Object.keys(files)
  if (paths.length !== configured.size) return false
  return paths.every(path => {
    const file = files[path]
    return configured.has(path) && !!file && (typeof file.body === 'string' || file.body instanceof ArrayBuffer) && typeof file.contentType === 'string' && file.contentType.trim().length > 0
  })
}

/** Only call after Catalogue has returned a shell outcome and checked the instance. */
export function serveShellAsset(request: Request, file: ShellAsset): Response {
  const headers = securityHeaders()
  headers.set('content-type', file.contentType)
  return new Response(request.method === 'HEAD' ? null : file.body, { headers })
}
