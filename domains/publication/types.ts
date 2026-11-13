import type { ManageDeps } from '../catalogue/commands'
import type { ManageActor } from '../catalogue/principals'
import type { RevisionStore } from '../store/revision-store'

export interface PublicationOptions {
  readonly sessionTtlMs: number
  readonly maxUploadTimeoutMs: number
  readonly retainMs: number
  readonly marginMs: number
  readonly manageClockSkewMs: number
  readonly readClockSkewMs: number
}
export interface PublicationDeps extends ManageDeps {
  readonly store: RevisionStore
  readonly publication: PublicationOptions
}
export type ResourceKind = 'document' | 'subdocument' | 'fragment' | 'asset'
export interface PublicationFile {
  readonly path: string
  readonly kind: ResourceKind
  readonly sha256: string
  readonly size: number
  readonly contentType: string
  readonly source: 'client' | 'base'
}
export interface PublicationPage {
  readonly pageId: string
  readonly disposition: 'new' | 'keep' | 'drop' | 'restore'
  readonly documentPath: string | null
  readonly metadata: unknown | null
  readonly expectedPolicyEpoch: number | null
}
export interface PublicationEdge {
  readonly ownerPageId: string
  readonly path: string
  /** null denotes this command's artefact, including a new artefact. */
  readonly providerArtifactId: string | null
}
export interface BeginCommand {
  readonly idempotencyKey: string
  readonly artifactId: string | null
  readonly expectedRevisionId: string | null
  readonly expectedContentVersion: number
  readonly files: readonly PublicationFile[]
  readonly pages: readonly PublicationPage[]
  readonly edges: readonly PublicationEdge[]
}
export interface PublicationStatus {
  readonly sessionId: string
  readonly artifactId: string
  readonly revisionId: string
  readonly baseRevisionId: string | null
  readonly expiresAt: number
  readonly state: 'open' | 'sealed' | 'committed' | 'closed'
  readonly files: readonly { readonly path: string; readonly source: 'client' | 'base'; readonly stored: boolean }[]
}
export interface PublicationReceipt {
  readonly artifactId: string
  readonly revisionId: string | null
  readonly contentVersion: number
  readonly pages: readonly { readonly pageId: string; readonly url: string }[]
}
export interface PromotionCommand {
  readonly idempotencyKey: string
  readonly artifactId: string
  readonly expectedContentVersion: number
}
export interface RestoreCommand extends PromotionCommand { readonly revisionId: string }
export interface Publication {
  begin(actor: ManageActor, command: BeginCommand): Promise<PublicationStatus>
  upload(actor: ManageActor, sessionId: string, path: string, body: ReadableStream<Uint8Array>): Promise<PublicationStatus>
  materialize(actor: ManageActor, sessionId: string, path: string): Promise<PublicationStatus>
  seal(actor: ManageActor, sessionId: string): Promise<PublicationStatus>
  commit(actor: ManageActor, sessionId: string): Promise<PublicationReceipt>
  status(actor: ManageActor, sessionId: string): Promise<PublicationStatus>
  abort(actor: ManageActor, sessionId: string): Promise<void>
  restore(actor: ManageActor, command: RestoreCommand): Promise<PublicationReceipt>
  unpublish(actor: ManageActor, command: PromotionCommand): Promise<PublicationReceipt>
}
