import { PolicyError } from './guard'
import type { ManageInstanceConfig, ReadInstanceConfig } from './instance-config'
import { isReservedShellPath } from './routing/grammar'

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

/** Validate against the instance marker and current subtree routes in one primary snapshot. */
export async function validateRevisionPaths(deps: RevisionPathDeps, input: RevisionPathInput): Promise<readonly RevisionPathConflict[]> {
  try {
    const results = await deps.db.batch([
      deps.db.prepare('SELECT instance_id FROM instance_meta WHERE singleton = 1'),
      deps.db.prepare("SELECT route_key, artifact_id FROM routes WHERE kind = 'subtree'"),
    ])
    if ((results[0].results[0] as { instance_id: string } | undefined)?.instance_id !== deps.config.instanceId) {
      throw new PolicyError('instance_mismatch')
    }

    const routes = new Map((results[1].results as { route_key: string; artifact_id: string }[]).map(row => [row.route_key, row.artifact_id]))
    const newSlugs = new Set(input.newSubtreeSlugs)
    const shellPaths = new Set(deps.config.shellPaths)
    const conflicts: RevisionPathConflict[] = []
    for (const path of input.paths) {
      const subtree = /^\/a\/([a-z0-9]+(?:-[a-z0-9]+)*)\//.exec(path)
      if (subtree) {
        const slug = subtree[1]
        const owner = routes.get(slug)
        if (owner !== undefined && owner !== input.artifactId) conflicts.push({ path, reason: 'foreign_subtree' })
        else if (owner === undefined && !newSlugs.has(slug)) conflicts.push({ path, reason: 'reserved' })
      } else if (isReservedShellPath(path)) conflicts.push({ path, reason: 'reserved' })
      else if (shellPaths.has(path)) conflicts.push({ path, reason: 'shell' })
    }
    return conflicts
  } catch (error) {
    if (error instanceof PolicyError) throw error
    throw new PolicyError('unavailable')
  }
}
