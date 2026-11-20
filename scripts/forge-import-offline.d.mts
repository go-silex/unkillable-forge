import type { SourceAccess } from './forge-import-physical.mjs'
export function prepare(args: { workspace: string; selection: string; roots: Record<string, string> }, access?: SourceAccess): Promise<{ command: string; fatal: string | null; units: number; pinned: number; warnings: Record<string, number> }>
