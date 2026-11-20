import type { Observation } from '../../../scripts/forge-import-selected.mjs'

type Visibility = { state: 'present'; value: string | null; metadataV: string | null; expiresAt: number | null } | { state: 'absent' | 'unknown' | 'unreadable' }
type Share = { state: 'present'; key: string | null; expiresAt: number | null } | { state: 'absent' | 'unknown' | 'unreadable' }
export interface SyntheticInput {
  version: 1; kind: 'synthetic'; sourceInstance: string; selectionRef: string
  approvalRef: string; g1bRef: null; capturedAt: number; corpusDigest: string
  selectionDigest: string; mappingRef: string; complete: true; targetBasis: 'empty'
  reader: { canonicalHost: string; aliasHosts: string[]; routeGrammars: ('tree' | 'subtree')[]; shareGrammars: ('page' | 'slug' | 'card')[]; shareCookie: boolean; shellPaths: string[] }
  captureRoots: string[]
  owners: { path: string; ownerSourcePageId: string; evidenceRef: string; basis: 'declared' }[]
  aliases: { aliasKind: 'redirect_exact' | 'redirect_prefix'; path: string; to: string; status: number; targetSourcePageId: string; capturedBehavior: string }[]
  previews: { sourcePageId: string; path: string; kind: string }[]
  consumerUrls: { url: string; purpose: string; targetSourcePageId: string | null; mappingRef: string | null }[]
  exclusions: { path: string; evidenceRef: string; reason: string }[]
  providerMounts: { artifactId: string; path: string; kind: string }[]
  pages: { sourcePageId: string; documentPath: string; metadata: unknown; ownershipEvidenceRef: string; membership: { sourceArtifactId: string; evidenceRef: string }; visibility: Visibility; share: Share }[]
  entries: { path: string; graphClass: string; contentType: string | null; locator: { root: string; relative: string }; provenance: string; expected: { size: number; sha256: string } | null; placement: { sourceArtifactId: string; evidenceRef: string } | null }[]
  shortlinks: { mappingId: string; providerOrigin: string; providerId: string | null; shortDomain: string; shortCode: string; shortUrl: string; targetSourcePageId: string; destination: string; observedAt: number }[]
  limits: { maxCommandBytes: number; maxJsonDepth: number; maxUploadBytes: number; maxInventoryBytes: number }
}
export function makeSelectedFixture(options?: { includeMissing?: boolean }): Promise<{ input: SyntheticInput; observations: Record<string, Observation>; files: Record<string, Uint8Array> }>
