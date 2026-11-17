import { env } from "cloudflare:workers"
import { beforeEach, expect, it } from "vitest"
import { PublicationService } from "../../domains/publication"
import { uploadImport } from "../../domains/publication/staging"
import type { PublicationDeps } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, bootstrap, configs, instanceId, jwks } from "./fixtures/catalogue"
import { body, clock, documentCommand } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })

async function setup() {
  const { manage } = await configs(), time = clock(10_000)
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 2_000, retainMs: 900_000, marginMs: 2_000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  const document = await documentCommand("transfer-deadline", "/transfer.html", "document")
  const session = await new PublicationService(deps).begin(actor, document.command)
  return { deps, store, document, session }
}

async function auditCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first<{n:number}>()
  return row!.n
}

// Integration exercises the real platform deadline clock, not the business clock.
async function afterDeadline(deadline: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, deadline - performance.now() + 10)))
  expect(performance.now()).toBeGreaterThanOrEqual(deadline)
}


it("does not dispatch an audit batch when the session read exhausts the deadline", async () => {
  const { deps, document, session } = await setup()
  const before = await auditCount()
  let deadline = 0
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, property) {
    if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values))
    if (property === "first") return async (...args: unknown[]) => {
      const result = await Reflect.apply(target.first, target, args)
      await afterDeadline(deadline)
      return result
    }
    const value = Reflect.get(target, property, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
  const db = new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      const statement = target.prepare(sql)
      return sql === "SELECT * FROM publication_sessions WHERE session_id = ?" ? wrap(statement) : statement
    }
    const value = Reflect.get(target, property, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
  deadline = performance.now() + 550
  await expect(uploadImport({ ...deps, db }, actor, session.sessionId, "/transfer.html", body(document.bytes), 500)).rejects.toMatchObject({ code: "unavailable", detail: "publication_upload_timeout" })
  expect(await auditCount()).toBe(before)
  expect(await env.DB.prepare("SELECT stored_at,object_key,object_version FROM publication_files WHERE session_id=? AND path=?").bind(session.sessionId, "/transfer.html").first()).toEqual({ stored_at: null, object_key: null, object_version: null })
})

it("does not dispatch a stored-at batch when the native put returns after the deadline", async () => {
  const { deps, store, document, session } = await setup()
  const before = await auditCount()
  let deadline = 0
  const delayed = new Proxy(store, { get(target, property) {
    if (property === "put") return async (...args: Parameters<RevisionStore["put"]>) => {
      const result = await target.put(...args)
      await afterDeadline(deadline)
      return result
    }
    const value = Reflect.get(target, property, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
  deadline = performance.now() + 550
  await expect(uploadImport({ ...deps, store: delayed }, actor, session.sessionId, "/transfer.html", body(document.bytes), 500)).rejects.toMatchObject({ code: "unavailable", detail: "publication_upload_timeout" })
  expect(await auditCount()).toBe(before + 1)
  expect(await env.DB.prepare("SELECT stored_at,object_key,object_version FROM publication_files WHERE session_id=? AND path=?").bind(session.sessionId, "/transfer.html").first()).toEqual({ stored_at: null, object_key: null, object_version: null })
  expect(await uploadImport(deps, actor, session.sessionId, "/transfer.html", body(document.bytes), 2_000)).toMatchObject({ stored: true })
}, 15_000)

it("awaits an already-dispatched native stored-at batch even if the deadline passes", async () => {
  const { deps, document, session } = await setup()
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>()
  const writes = new WeakSet<D1PreparedStatement>()
  let deadline = 0
  let signalReached!: () => void, signalRelease!: () => void
  const reached = new Promise<void>(resolve => { signalReached = resolve })
  const release = new Promise<void>(resolve => { signalRelease = resolve })
  const wrap = (statement: D1PreparedStatement, write: boolean): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), write)
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    } })
    originals.set(proxy, statement)
    if (write) writes.add(proxy)
    return proxy
  }
  const db = new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql.startsWith("UPDATE publication_files SET object_key"))
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      const result = await target.batch(statements.map(s => originals.get(s) ?? s))
      if (statements.some(s => writes.has(s))) { signalReached(); await release }
      return result
    }
    const value = Reflect.get(target, property, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
  try {
    let settled = false
    deadline = performance.now() + 550
    const pending = uploadImport({ ...deps, db }, actor, session.sessionId, "/transfer.html", body(document.bytes), 500).finally(() => { settled = true })
    await Promise.race([reached, pending.then(() => { throw new Error("upload completed before the native batch gate") })])
    await afterDeadline(deadline)
    await Promise.resolve()
    expect(settled).toBe(false)
    signalRelease()
    expect(await pending).toMatchObject({ stored: true, state: "open" })
    expect(await env.DB.prepare("SELECT stored_at FROM publication_files WHERE session_id=? AND path=?").bind(session.sessionId, "/transfer.html").first()).toEqual({ stored_at: 10_000 })
  } finally { signalRelease() }
}, 15_000)
