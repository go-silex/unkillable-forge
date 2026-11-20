import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { Observation, Unit, RepresentableUnit, SourceFailureFact, UnitFailureFact, assignSourcePins, sealInventory } from './forge-import-selected.mjs'
import type { ImportApproval } from '../domains/catalogue/import'

type SourceRoot = { open(relativePath: string): Promise<FileHandle>; close(): Promise<void> }
type Locator = { root: string; relative: string }
export type PhysicalRead = { ordinal: number; path: string; locator: Locator; sourceKey: string; expected: { size: number; sha256: string } }
type ProtectedLocator = { ordinal: number; locator: Locator }
type Admission = { identity: BigIntStats } | { observation: Observation }
type Inspection = { observation: Observation; identity?: BigIntStats }
export interface SourceAccess {
  metadata(source: SourceRoot, relative: string): Promise<BigIntStats>
  inspect(source: SourceRoot, relative: string, authorized: BigIntStats, expectedSize: number): Promise<Inspection>
  readPinned(source: SourceRoot, relative: string, observed: Extract<Observation, { state: 'present' }>, initial: BigIntStats | undefined, cap: number): Promise<Uint8Array>
}
export const sourceAccess: SourceAccess
export function authorizeSources(options: { reads: PhysicalRead[]; protectedLocators: ProtectedLocator[]; inventoryKeys: string[]; sources: Map<string, SourceRoot>; rootPaths: Map<string, string>; isProtectedCaptureRelative(value: unknown): boolean }, access?: SourceAccess): Promise<Map<number, Admission>>
export function inspectSources(reads: PhysicalRead[], authorization: Map<number, Admission>, sources: Map<string, SourceRoot>, access?: SourceAccess): Promise<{ observations: Record<string, Observation>; identities: Map<string, BigIntStats> }>
export function pinUnits(options: { units: Unit[]; reads: PhysicalRead[]; observations: Record<string, Observation>; identities: Map<string, BigIntStats>; sources: Map<string, SourceRoot>; bucket: { put(key: string, bytes: Uint8Array): Promise<{ key: string; version: string }> }; transport: { maxUploadBytes: number }; assignSourcePins: typeof assignSourcePins; sealInventory: typeof sealInventory; validateUnit(unit: RepresentableUnit): void }, access?: SourceAccess): Promise<{ units: Unit[]; approvals: ImportApproval[]; pinFailures: (SourceFailureFact | UnitFailureFact)[] }>
export function createAssertionSigner(options: { privateKey: JsonWebKey; kid: string; now?: () => number }): Promise<() => Promise<string>>
