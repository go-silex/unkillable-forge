import { PolicyError } from './guard'
import type { ManageInstanceConfig, ReadInstanceConfig } from './instance-config'
import { isReservedShellPath, subtreeSlugOf, validPageRef, type SubtreeOrTree } from './routing/grammar'

export interface RevisionPathDeps {
  readonly db: D1Database
  readonly config: ReadInstanceConfig | ManageInstanceConfig
}

export interface RevisionPathInput {
  readonly artifactId: string | null
  readonly paths: readonly string[]
  readonly resultingSubtreeSlugs: readonly string[]
}

export interface RevisionPathConflict {
  readonly path: string
  readonly reason: 'reserved' | 'shell' | 'foreign_subtree' | 'dropped_subtree'
}

/** Interpret a canonical document path as its primary route; invalid paths have no route. */
export function documentRouteOf(path: string): SubtreeOrTree | null {
  const slug = subtreeSlugOf(path)
  if (slug !== null) return path === `/a/${slug}/index.html` ? { kind: 'subtree', slug } : null
  if (!path.startsWith('/') || path.startsWith('/a/')) return null
  const pageRef = path.slice(1)
  return validPageRef(pageRef)
    ? { kind: 'tree_page', pageRef }
    : null
}

/** Bound JSON by UTF-8 bytes without limiting the total number of slugs. */
function jsonChunks(values: Iterable<string>): string[] {
  const encoder = new TextEncoder()
  const chunks: string[] = []
  let entries: string[] = [], size = 2
  for (const value of values) {
    const item = JSON.stringify(value), bytes = encoder.encode(item).length
    if (bytes + 2 > 65536) throw new PolicyError('invalid_state')
    if (size + bytes + (entries.length ? 1 : 0) > 65536) {
      chunks.push(`[${entries.join(',')}]`); entries = []; size = 2
    }
    size += bytes + (entries.length ? 1 : 0); entries.push(item)
  }
  if (entries.length) chunks.push(`[${entries.join(',')}]`)
  return chunks
}

/** Validate touched routes and resulting subtree mounts in one primary snapshot. */
export async function validateRevisionPaths(deps: RevisionPathDeps, input: RevisionPathInput): Promise<readonly RevisionPathConflict[]> {
  try {
    const resulting = new Set(input.resultingSubtreeSlugs)
    const touched = new Set(resulting)
    for (const path of input.paths) {
      const slug = subtreeSlugOf(path)
      if (slug !== null) touched.add(slug)
    }
    const routeChunks = jsonChunks(touched), mountChunks = jsonChunks(resulting)
    const results = await deps.db.batch([
      deps.db.prepare('SELECT instance_id FROM instance_meta WHERE singleton = 1'),
      ...routeChunks.map(chunk => deps.db.prepare("SELECT route_key, artifact_id FROM routes WHERE kind = 'subtree' AND route_key IN (SELECT value FROM json_each(?))").bind(chunk)),
      ...mountChunks.map(chunk => deps.db.prepare("SELECT m.path FROM json_each(?1) s JOIN mounts m ON m.path >= '/a/' || s.value || '/' AND m.path < '/a/' || s.value || '0' AND m.artifact_id IS NOT ?2").bind(chunk, input.artifactId)),
    ])
    if ((results[0].results[0] as { instance_id: string } | undefined)?.instance_id !== deps.config.instanceId) {
      throw new PolicyError('instance_mismatch')
    }
    const routes = new Map(results.slice(1, 1 + routeChunks.length).flatMap(result =>
      (result.results as { route_key: string; artifact_id: string }[]).map(row => [row.route_key, row.artifact_id] as const)))
    const shellPaths = new Set(deps.config.shellPaths)
    const conflicts: RevisionPathConflict[] = []
    for (const path of input.paths) {
      const slug = subtreeSlugOf(path)
      if (slug !== null) {
        const owner = routes.get(slug)
        if (owner !== undefined && owner !== input.artifactId) conflicts.push({ path, reason: 'foreign_subtree' })
        else if (!resulting.has(slug)) conflicts.push({ path, reason: owner === undefined ? 'reserved' : 'dropped_subtree' })
      } else if (isReservedShellPath(path)) conflicts.push({ path, reason: 'reserved' })
      else if (shellPaths.has(path)) conflicts.push({ path, reason: 'shell' })
    }
    for (const result of results.slice(1 + routeChunks.length)) {
      for (const mount of result.results as { path: string }[]) conflicts.push({ path: mount.path, reason: 'foreign_subtree' })
    }
    return conflicts
  } catch (error) {
    if (error instanceof PolicyError) throw error
    throw new PolicyError('unavailable')
  }
}
