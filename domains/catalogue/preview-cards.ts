import type { ReadInstanceConfig } from './instance-config'
import { resolvePagePreview, type PreviewRequest, type SharedPreviewPlan } from './previews'

export type CardSelection =
  | { readonly kind: 'original'; readonly path: string }
  | { readonly kind: 'derived'; readonly recipeSha256: string; readonly inputSha256: string; readonly contentSha256: string; readonly extension: 'jpg' | 'png' }

export interface PreviewCardPlan {
  readonly kind: 'card'
  readonly instanceId: string
  readonly artifactId: string
  readonly revisionId: string
  readonly pageId: string
  readonly descriptor: NonNullable<SharedPreviewPlan['image']>
  readonly authority: SharedPreviewPlan['authority']
  readonly cache: 'no-store'
}

/** Every request resolves the current authority and exact selected image afresh. */
export async function resolvePreviewCard(db: D1Database, config: ReadInstanceConfig, input: PreviewRequest & {
  readonly pageId: string
  readonly revisionId: string
  readonly selection: CardSelection
}): Promise<PreviewCardPlan | null> {
  const plan = await resolvePagePreview(db, config, input)
  if (!plan || plan.pageId !== input.pageId || plan.revisionId !== input.revisionId || !plan.image) return null
  const image = plan.image, selection = input.selection
  if (image.kind !== selection.kind) return null
  if (image.kind === 'original') {
    if (selection.kind !== 'original' || image.path !== selection.path) return null
  } else {
    if (selection.kind !== 'derived') return null
    const ref = image.descriptor.ref
    if (ref.recipeSha256 !== selection.recipeSha256 || ref.inputSha256 !== selection.inputSha256 || ref.contentSha256 !== selection.contentSha256 || ref.extension !== selection.extension) return null
  }
  return { kind: 'card', instanceId: plan.instanceId, artifactId: plan.artifactId, revisionId: plan.revisionId, pageId: plan.pageId, descriptor: image, authority: plan.authority, cache: 'no-store' }
}
