export function prepareSelection(options: {
  captureDir: string
  selectionOut: string
  captureRootOut: string
  instance?: 'unkillable' | 'roxabi'
  kind?: 'synthetic' | 'historical'
  g1bRef?: string
  shortDomain?: string
  providerOrigin?: string
  allowPartial?: boolean
  capturedAt?: number
  selectionRef?: string
  approvalRef?: string
  mappingRef?: string
  targetBasis?: 'empty' | 'unknown'
  limits?: Record<string, number>
  reader?: Record<string, unknown>
  profile?: Record<string, unknown>
}): Promise<{
  command: 'prepare-selection'
  instance: string
  selection: string
  captureRoot: string
  counts: Record<string, number>
  evidence: { files: number; captureRoot: string }
  refused: { total: number; byReason: Record<string, number> }
  refusedRecords: Array<Record<string, unknown>>
}>

export function pinWorkspace(options: {
  workspace: string
  roots: Record<string, string>
  putObject: (key: string, bytes: Uint8Array | Buffer) => Promise<{ key?: string; version: string }>
  inventoriesOut?: string | null
}): Promise<{
  command: 'pin'
  pinned: number
  blocked: number
  approvals: number
  FORGE_IMPORT_INVENTORIES: string
}>

export function applyImport(options: {
  manageHost: string
  selections: Array<{ version: 1; inventoryId: string; selectionId: string; planId: string; command: unknown }>
  fetch?: typeof fetch
  headers?: Record<string, string>
  dryRunOnly?: boolean
  continueOnBlock?: boolean
}): Promise<{ command: 'apply'; manageHost: string; results: Array<Record<string, unknown>> }>

export function selectionsFromWorkspace(workspace: string): Promise<Array<{ version: 1; inventoryId: string; selectionId: string; planId: string; command: unknown }>>
