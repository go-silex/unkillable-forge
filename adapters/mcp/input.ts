import { InputError } from '../http/publication-input'
import type { TransportOptions } from '../http/manage-config'

export async function readMcpJson(request: Request, options: TransportOptions): Promise<unknown> {
  if (!request.body) throw new InputError('invalid_request')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InputError('request_timeout')), options.commandReadTimeoutMs) })
  try {
    for (;;) {
      const part = await Promise.race([reader.read().catch(() => { throw new InputError('request_timeout') }), timeout])
      if (part.done) break
      if (!(part.value instanceof Uint8Array)) throw new InputError('invalid_request')
      size += part.value.byteLength
      if (size > options.maxCommandBytes) throw new InputError('payload_too_large')
      chunks.push(part.value)
    }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = ''
    for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
    const value: unknown = JSON.parse(text + decoder.decode())
    const stack: [unknown, number][] = [[value, 1]]
    while (stack.length) {
      const [item, depth] = stack.pop()!
      if (typeof item === 'number' && !Number.isFinite(item)) throw new InputError('invalid_request')
      if (item !== null && typeof item === 'object') {
        if (depth > options.maxJsonDepth) throw new InputError('invalid_request')
        for (const child of Object.values(item)) stack.push([child, depth + (child !== null && typeof child === 'object' ? 1 : 0)])
      }
    }
    return value
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError('invalid_request')
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* pending read settles independently */ }
  }
}
