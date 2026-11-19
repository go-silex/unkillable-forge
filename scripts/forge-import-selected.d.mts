import type { ApprovedImportInventory, ImportApproval, ImportFile, ImportSelection } from '../domains/catalogue/import'
import type { BeginCommand } from '../domains/publication/types'

export const SELECTED_IMPORT_SCHEMA: 1
export function stable(value: unknown): string
export interface Ledger {
  version: 2
  pages: Record<string, string>
  grants: Record<string, string>
  idempotencyKeys: Record<string, string>
  inventoryIds: Record<string, string>
  selectionIds: Record<string, string>
  planIds: Record<string, string>
  operationIds: Record<string, string>
}
export interface Issue { code: string; path?: string; sourcePageId?: string | null; unitId?: string; basis?: string; budget?: Budget; entryOrdinal?: number; stage?: 'inspect' | 'pin_reread'; reason?: SourceFailureFact['reason'] }
export interface Budget {
  files: number; pages: number; edges: number; largestFile: number
  commandBytes: number; envelopeBytes: number; inventoryBytes: number; failed: string[]
}
export interface InventoryDraft extends Omit<ApprovedImportInventory, 'files'> {
  files: readonly (Omit<ImportFile, 'sourceVersion'> & { sourceVersion: string | null })[]
}
interface UnitCommon {
  unitId: string; blockers: Issue[]; budget: Budget
  dependencies: { path: string; providerArtifactId: string | null; kind: 'fragment' | 'asset' | null; state: 'unverified' | 'missing' }[]
  sourceArtifactId: string; maxInventoryBytes: number; inventoryKey: string | null
  sourceEvidence: { membership: { sourcePageId: string; evidenceRef: string }[]; placement: { path: string; evidenceRef: string }[] }
}
export interface RepresentableUnit extends UnitCommon {
  status: 'representable'
  pinState: 'awaiting_source' | 'awaiting_inventory' | 'pinned'
  inventoryKey: string
  command: BeginCommand
  selection: ImportSelection
  inventory: InventoryDraft
  approval?: ImportApproval
}
export interface BlockedUnit extends UnitCommon {
  status: 'blocked'; pinState: 'blocked'
  command: null; selection: null; inventory: null
}
export type Unit = RepresentableUnit | BlockedUnit
interface TranslationCommon {
  schema: 1; ledger: Ledger
  accounting: { path: string; disposition: string; unitId: string | null; reason: string }[]
  census: { kind: string; ordinal: number; unitId: string | null; affectedUnitIds: string[]; disposition: 'represented' | 'excluded' | 'rejected' }[]
  units: Unit[]
  compatibility: { represented: Issue[]; unsupported: Issue[]; notObserved: Issue[] }
  warnings: Issue[]
}
export interface FatalTranslation extends TranslationCommon {
  ok: false; fatal: string; facts?: never
}
export interface ProjectableTranslation extends TranslationCommon {
  ok: boolean; fatal: null; facts: unknown[]
}
export type Translation = FatalTranslation | ProjectableTranslation
export type Observation =
  | { state: 'present'; size: number; sha256: string }
  | { state: 'absent' | 'unreadable' | 'unknown' | 'changed' | 'size_mismatch' }
export interface SourceFailureFact { kind: 'source'; entryOrdinal: number; stage: 'inspect' | 'pin_reread'; reason: 'absent' | 'unreadable' | 'unknown' | 'changed' | 'size_mismatch' | 'digest_mismatch' }
export interface UnitFailureFact { kind: 'unit'; unitId: string; code: 'budget_exceeded' | 'inventory_budget_exceeded' }
export function isProtectedCaptureRelative(value: unknown): boolean
export function emptyLedger(): Ledger
export function preflightSelection(input: unknown, ledger?: unknown): Promise<
  | { kind: 'fatal'; result: FatalTranslation }
  | { kind: 'prepared'; reads: { ordinal: number; path: string; sourceKey: string; unitId: string; sourcePageId: string | null; publicDocument: boolean; locator: { root: string; relative: string }; expected: { size: number; sha256: string } }[]; protectedLocators: { ordinal: number; locator: { root: string; relative: string } }[]; inventoryKeys: string[]; reader: unknown; limits: unknown; captureRoots: string[]; finish(observations?: unknown): Promise<ProjectableTranslation> }
>
export function projectTranslation(translation: FatalTranslation): FatalTranslation
export function projectTranslation(translation: ProjectableTranslation, pinFailures?: (SourceFailureFact | UnitFailureFact)[]): ProjectableTranslation
export function projectTranslation(translation: Translation): Translation
export function assignSourcePins(unit: Unit, pins: unknown):
  | { ok: false; code: string; path?: string }
  | { ok: true; unit: RepresentableUnit; bytes: Uint8Array }
export function sealInventory(unit: Unit, object: unknown, sha256: string):
  | { ok: false; code: string }
  | { ok: true; unit: RepresentableUnit; approval: ImportApproval }
