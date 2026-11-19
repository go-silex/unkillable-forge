import type { ApprovedImportInventory, ImportApproval, ImportFile, ImportSelection } from '../domains/catalogue/import'
import type { BeginCommand } from '../domains/publication/types'

export const SELECTED_IMPORT_SCHEMA: 1
export function stable(value: unknown): string
export interface Ledger {
  version: 1
  pages: Record<string, string>
  grants: Record<string, string>
  sourceArtifacts: Record<string, string>
  idempotencyKeys: Record<string, string>
  inventoryIds: Record<string, string>
  selectionIds: Record<string, string>
  planIds: Record<string, string>
  operationIds: Record<string, string>
}
export interface Issue { code: string; path?: string; sourcePageId?: string; unitId?: string; budget?: Budget }
export interface Budget {
  files: number; pages: number; edges: number; largestFile: number
  commandBytes: number; envelopeBytes: number; inventoryBytes: number; failed: string[]
}
export interface InventoryDraft extends Omit<ApprovedImportInventory, 'files'> {
  files: readonly (Omit<ImportFile, 'sourceVersion'> & { sourceVersion: string | null })[]
}
interface UnitCommon {
  unitId: string; blockers: Issue[]; budget: Budget
  dependencies: { path: string; providerArtifactId: string | null; state: 'active' | 'missing' }[]
  sourceArtifactId: string; maxInventoryBytes: number
}
export interface RepresentableUnit extends UnitCommon {
  status: 'representable'
  pinState: 'awaiting_source' | 'awaiting_inventory' | 'pinned'
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
export interface Translation {
  ok: boolean; schema: 1; ledger: Ledger
  accounting: { path: string; disposition: string; unitId: string | null; reason: string }[]
  units: Unit[]
  compatibility: { represented: Issue[]; unsupported: Issue[]; notObserved: Issue[] }
  warnings: Issue[]
}
export type Observation =
  | { state: 'present'; size: number; sha256: string }
  | { state: 'absent' | 'unreadable' | 'unknown' }
export function emptyLedger(): Ledger
export function translateSelection(input: unknown, ledger?: unknown, observations?: unknown): Promise<Translation>
export function assignSourcePins(unit: Unit, pins: unknown):
  | { ok: false; code: string; path?: string }
  | { ok: true; unit: RepresentableUnit; bytes: Uint8Array }
export function sealInventory(unit: Unit, object: unknown, sha256: string):
  | { ok: false; code: string }
  | { ok: true; unit: RepresentableUnit; approval: ImportApproval }
