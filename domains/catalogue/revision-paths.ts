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
  readonly newSubtreeSlugs: readonly string[]
}

export interface RevisionPathConflict {
  readonly path: string
  readonly reason: 'reserved' | 'shell' | 'foreign_subtree'
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

/** Validate against the instance marker and current subtree routes in one primary snapshot. */
export async function validateRevisionPaths(deps: RevisionPathDeps, input: RevisionPathInput): Promise<readonly RevisionPathConflict[]> {
  try {
    const results = await deps.db.batch([
      deps.db.prepare('SELECT instance_id FROM instance_meta WHERE singleton = 1'),
      deps.db.prepare("SELECT route_key, artifact_id FROM routes WHERE kind = 'subtree'"),
      deps.db.prepare("SELECT path, artifact_id FROM mounts"),
    ])
    if ((results[0].results[0] as { instance_id: string } | undefined)?.instance_id !== deps.config.instanceId) {
      throw new PolicyError('instance_mismatch')
    }

    const routes = new Map((results[1].results as { route_key: string; artifact_id: string }[]).map(row => [row.route_key, row.artifact_id]))
    const mounts = results[2].results as { path: string; artifact_id: string }[]
    const newSlugs = new Set(input.newSubtreeSlugs)
    const shellPaths = new Set(deps.config.shellPaths)
    const conflicts: RevisionPathConflict[] = []
    for (const path of input.paths) {
      const slug = subtreeSlugOf(path)
      if (slug !== null) {
        const owner = routes.get(slug)
        if (owner !== undefined && owner !== input.artifactId) conflicts.push({ path, reason: 'foreign_subtree' })
        else if (owner === undefined && !newSlugs.has(slug)) conflicts.push({ path, reason: 'reserved' })
      } else if (isReservedShellPath(path)) conflicts.push({ path, reason: 'reserved' })
      else if (shellPaths.has(path)) conflicts.push({ path, reason: 'shell' })
    }
    const claimedSlugs = new Set([...newSlugs, ...[...routes].filter(([, owner]) => owner === input.artifactId).map(([slug]) => slug)])
    for (const slug of claimedSlugs) {
      for (const mount of mounts) {
        if (mount.artifact_id !== input.artifactId && subtreeSlugOf(mount.path) === slug) {
          conflicts.push({ path: mount.path, reason: 'foreign_subtree' })
        }
      }
    }
    return conflicts
  } catch (error) {
    if (error instanceof PolicyError) throw error
    throw new PolicyError('unavailable')
  }
}
