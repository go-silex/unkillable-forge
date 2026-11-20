import type { ImportOperation } from './import'

/** Indices of operations that cannot coexist in the same imported revision. */
export function conflictingImportOperationIndexes(operations: readonly ImportOperation[]): ReadonlySet<number> {
  const conflicts = new Set<number>()
  const previews = new Map<string, number>(), linkIds = new Map<string, number>(), linkIdentities = new Map<string, number>()
  const grants = new Map<string, { pageId:string | null; conflicting:boolean }>()
  const aliases = new Map<string, { indices:number[]; value:string; conflicting:boolean }>()
  const claim = (map: Map<string, number>, key: string, index: number) => {
    const first = map.get(key)
    if (first === undefined) map.set(key, index)
    else { conflicts.add(first); conflicts.add(index) }
  }
  operations.forEach((op, index) => {
    if (op.kind === 'preview_selection') claim(previews, op.pageId, index)
    else if (op.kind === 'shortlink') {
      claim(linkIds, op.mapping.mappingId, index)
      claim(linkIdentities, JSON.stringify([op.mapping.providerOrigin,op.mapping.shortDomain,op.mapping.shortCode]), index)
    } else if (op.kind === 'alias') {
      const key = JSON.stringify([op.aliasKind,op.path]), value = JSON.stringify([op.to,op.status,op.targetPageId])
      const first = aliases.get(key)
      if (!first) aliases.set(key, {indices:[index],value,conflicting:false})
      else {
        if (first.value !== value) first.conflicting = true
        first.indices.push(index)
      }
    }
    const grantId = op.kind === 'page_policy' && op.policy.visibility.value === 'shared' ? op.policy.grantId : op.kind === 'shortlink' ? op.mapping.grantId : null
    const pageId = op.kind === 'page_policy' ? op.policy.pageId : op.kind === 'shortlink' ? op.mapping.pageId : null
    if (grantId) {
      const first = grants.get(grantId)
      if (!first) grants.set(grantId, {pageId,conflicting:false})
      else if (first.pageId !== pageId) first.conflicting = true
    }
  })
  for (const alias of aliases.values()) if (alias.conflicting) for (const index of alias.indices) conflicts.add(index)
  operations.forEach((op,index) => {
    const grantId = op.kind === 'page_policy' && op.policy.visibility.value === 'shared' ? op.policy.grantId : op.kind === 'shortlink' ? op.mapping.grantId : null
    if (grantId && grants.get(grantId)?.conflicting) conflicts.add(index)
  })
  return conflicts
}
