import type { ManageActor } from '../catalogue/principals'
import type { BeginCommand, Publication, PublicationDeps, PromotionCommand, RestoreCommand } from './types'
import * as staging from './staging'
import * as promotion from './promotion'
export * from './types'

export class PublicationService implements Publication {
  constructor(private readonly deps: PublicationDeps) {
    const { sessionTtlMs, maxUploadTimeoutMs, retainMs, marginMs, manageClockSkewMs, readClockSkewMs } = deps.publication
    if (deps.store.instanceId !== deps.config.instanceId ||
        ![sessionTtlMs, maxUploadTimeoutMs, retainMs, marginMs, manageClockSkewMs, readClockSkewMs].every(Number.isSafeInteger) ||
        sessionTtlMs <= 0 || maxUploadTimeoutMs <= 0 || manageClockSkewMs < 0 || readClockSkewMs < 0 ||
        retainMs < 900_000 + manageClockSkewMs + readClockSkewMs ||
        marginMs < maxUploadTimeoutMs + manageClockSkewMs + readClockSkewMs) {
      throw new RangeError('Invalid trusted publication configuration')
    }
  }
  begin(actor: ManageActor, command: BeginCommand) { return staging.begin(this.deps, actor, command) }
  upload(actor: ManageActor, sessionId: string, path: string, body: ReadableStream<Uint8Array>) { return staging.upload(this.deps, actor, sessionId, path, body) }
  materialize(actor: ManageActor, sessionId: string, path: string) { return staging.materialize(this.deps, actor, sessionId, path) }
  seal(actor: ManageActor, sessionId: string) { return staging.seal(this.deps, actor, sessionId) }
  commit(actor: ManageActor, sessionId: string) { return promotion.commit(this.deps, actor, sessionId) }
  status(actor: ManageActor, sessionId: string) { return staging.status(this.deps, actor, sessionId) }
  abort(actor: ManageActor, sessionId: string) { return staging.abort(this.deps, actor, sessionId) }
  restore(actor: ManageActor, command: RestoreCommand) { return promotion.restore(this.deps, actor, command) }
  unpublish(actor: ManageActor, command: PromotionCommand) { return promotion.unpublish(this.deps, actor, command) }
}
