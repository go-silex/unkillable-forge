/** Minimal in-memory KV mock for Pages Functions tests. */
export function mockKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial))

  return {
    get: async (key: string, type?: string) => {
      const v = store.get(key)
      if (v === undefined) return null
      if (type === "json") return JSON.parse(v) as unknown
      if (type === "arrayBuffer") return new TextEncoder().encode(v).buffer
      if (type === "stream") {
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(v))
            c.close()
          },
        })
      }
      return v
    },
    put: async (key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) => {
      store.set(
        key,
        typeof value === "string" ? value : new TextDecoder().decode(value as ArrayBuffer),
      )
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async (key: string, type?: string) => {
      const v = store.get(key)
      if (v === undefined) {
        return { value: null, metadata: null, cacheStatus: null }
      }
      if (type === "json") {
        return {
          value: JSON.parse(v) as unknown,
          metadata: null,
          cacheStatus: null,
        }
      }
      return { value: v, metadata: null, cacheStatus: null }
    },
  } as unknown as KVNamespace
}

export function failingKvAfter(
  initial: Record<string, string>,
  failKey: string,
): KVNamespace {
  const inner = mockKv(initial)
  return {
    ...inner,
    put: async (key, value) => {
      if (key === failKey) throw new Error(`kv_put_failed:${key}`)
      return inner.put(key, value)
    },
    delete: async (key) => {
      if (key === failKey) throw new Error(`kv_delete_failed:${key}`)
      return inner.delete(key)
    },
  }
}
