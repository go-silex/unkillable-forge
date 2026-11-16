import type { BeginCommand, PromotionCommand, RestoreCommand } from '../../domains/publication'
import type { TransportOptions } from './manage-config'

export type InputCode = 'invalid_request' | 'payload_too_large' | 'request_timeout' | 'unsupported_media_type'
export class InputError extends Error {
  constructor(readonly code: InputCode) { super(code) }
}
export type Command =
  | { op: 'begin'; command: BeginCommand }
  | { op: 'materialize'; sessionId: string; path: string }
  | { op: 'seal' | 'commit' | 'status' | 'abort'; sessionId: string }
  | { op: 'restore'; command: RestoreCommand }
  | { op: 'unpublish'; command: PromotionCommand }

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const str = (v: unknown): v is string => typeof v === 'string'
const nullableString = (v: unknown) => v === null || str(v)
const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v)
const oneOf = (v: unknown, values: string[]) => str(v) && values.includes(v)

function validateDepth(root: unknown, max: number): void {
  const stack: [unknown, number][] = [[root, 1]]
  while (stack.length) {
    const [value, depth] = stack.pop()!
    if (typeof value === 'number' && !Number.isFinite(value)) throw new InputError('invalid_request')
    if (value !== null && typeof value === 'object') {
      if (depth > max) throw new InputError('invalid_request')
      for (const child of Object.values(value)) stack.push([child, depth + (child !== null && typeof child === 'object' ? 1 : 0)])
    }
  }
}
function validateCommand(value: unknown, cap: number): Command {
  if (!record(value) || !str(value.op)) throw new InputError('invalid_request')
  const fail = (): never => { throw new InputError('invalid_request') }
  switch (value.op) {
    case 'begin': {
      if (!exact(value, ['op', 'command']) || !exact(value.command, ['idempotencyKey', 'artifactId', 'expectedRevisionId', 'expectedContentVersion', 'files', 'pages', 'edges'])) return fail()
      const c = value.command
      if (!str(c.idempotencyKey) || !nullableString(c.artifactId) || !nullableString(c.expectedRevisionId) || !integer(c.expectedContentVersion) || !Array.isArray(c.files) || !Array.isArray(c.pages) || !Array.isArray(c.edges)) return fail()
      for (const f of c.files) {
        if (!exact(f, ['path', 'kind', 'sha256', 'size', 'contentType', 'source']) || !str(f.path) || !oneOf(f.kind, ['document', 'subdocument', 'fragment', 'asset']) || !str(f.sha256) || !integer(f.size) || !str(f.contentType) || !oneOf(f.source, ['client', 'base'])) return fail()
        if ((f.size as number) > cap) throw new InputError('payload_too_large')
      }
      for (const p of c.pages) if (!exact(p, ['pageId', 'disposition', 'documentPath', 'metadata', 'expectedPolicyEpoch']) || !str(p.pageId) || !oneOf(p.disposition, ['new', 'keep', 'drop', 'restore']) || !nullableString(p.documentPath) || !(p.expectedPolicyEpoch === null || integer(p.expectedPolicyEpoch))) return fail()
      for (const e of c.edges) if (!exact(e, ['ownerPageId', 'path', 'providerArtifactId']) || !str(e.ownerPageId) || !str(e.path) || !nullableString(e.providerArtifactId)) return fail()
      break
    }
    case 'materialize': if (!exact(value, ['op', 'sessionId', 'path']) || !str(value.sessionId) || !str(value.path)) return fail(); break
    case 'seal': case 'commit': case 'status': case 'abort': if (!exact(value, ['op', 'sessionId']) || !str(value.sessionId)) return fail(); break
    case 'restore': case 'unpublish': {
      if (!exact(value, ['op', 'command'])) return fail()
      const keys = value.op === 'restore' ? ['idempotencyKey', 'artifactId', 'expectedContentVersion', 'revisionId'] : ['idempotencyKey', 'artifactId', 'expectedContentVersion']
      if (!exact(value.command, keys) || !str(value.command.idempotencyKey) || !str(value.command.artifactId) || !integer(value.command.expectedContentVersion) || (value.op === 'restore' && !str(value.command.revisionId))) return fail()
      break
    }
    default: return fail()
  }
  return value as unknown as Command
}

export function checkFraming(request: Request, upload: boolean, cap: number): void {
  const contentType = request.headers.get('content-type') ?? ''
  if (!(upload ? /^application\/octet-stream$/i : /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i).test(contentType)) throw new InputError('unsupported_media_type')
  const encoding = request.headers.get('content-encoding')
  if (encoding !== null && !/^identity$/i.test(encoding)) throw new InputError('unsupported_media_type')
  const length = request.headers.get('content-length')
  if (length !== null) {
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new InputError('invalid_request')
    if (Number(length) > cap) throw new InputError('payload_too_large')
    if (!request.body && Number(length) !== 0) throw new InputError('invalid_request')
  }
}

export function cancelBody(request: Request): void {
  if (request.body && !request.body.locked) void request.body.cancel().catch(() => {})
}

export async function readCommand(request: Request, options: TransportOptions): Promise<Command> {
  if (!request.body) throw new InputError('invalid_request')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InputError('request_timeout')), options.commandReadTimeoutMs) })
  try {
    for (;;) {
      const part = await Promise.race([
        reader.read().catch(() => { throw new InputError('request_timeout') }),
        timeout,
      ])
      if (part.done) break
      if (!(part.value instanceof Uint8Array)) throw new InputError('invalid_request')
      size += part.value.byteLength
      if (size > options.maxCommandBytes) throw new InputError('payload_too_large')
      chunks.push(part.value)
    }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = ''
    for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
    text += decoder.decode()
    const parsed: unknown = JSON.parse(text)
    validateDepth(parsed, options.maxJsonDepth)
    return validateCommand(parsed, options.maxUploadBytes)
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError('invalid_request')
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* pending read settles independently */ }
  }
}

export function uploadStream(request: Request, max: number): { body: ReadableStream<Uint8Array>; cleanup: () => void; failure: () => InputError | null } {
  const reader = request.body?.getReader()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let open = true
  let size = 0
  let failed: InputError | null = null
  const cleanup = () => {
    if (!open) return
    open = false
    request.signal.removeEventListener('abort', abort)
    if (reader) {
      void reader.cancel().catch(() => {})
      try { reader.releaseLock() } catch { /* cancellation may have a pending read */ }
    }
  }
  const abort = () => {
    if (!open) return
    failed = new InputError('request_timeout')
    controller?.error(failed)
    cleanup()
  }
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort() },
    async pull(c) {
      if (!open) return
      if (!reader) { c.close(); cleanup(); return }
      try {
        const part = await reader.read()
        if (!open) return
        if (part.done) { c.close(); cleanup(); return }
        if (!(part.value instanceof Uint8Array)) throw new InputError('invalid_request')
        size += part.value.byteLength
        if (size > max) throw new InputError('payload_too_large')
        c.enqueue(part.value)
      } catch (error) {
        if (!open) return
        failed = error instanceof InputError ? error : new InputError('request_timeout')
        c.error(failed)
        cleanup()
      }
    },
    cancel() { cleanup() },
  }, { highWaterMark: 0 })
  return { body, cleanup, failure: () => failed }
}
