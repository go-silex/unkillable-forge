import { z } from 'zod'

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z2-7]{26}$`))
const artifactId = id('ar'), revisionId = id('rv'), pageId = id('pg'), sessionId = id('ps')
const integer = z.number().int().nonnegative().safe()
const path = z.string().min(2).max(1024).startsWith('/')
const cursor = z.string().min(1).max(16384).nullable()
const route = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('subtree'), slug: z.string().min(1) }), z.strictObject({ kind: z.literal('tree_page'), pageRef: z.string().min(1) })])
export const artifactStateSchema = z.strictObject({ artifactId, activeRevisionId: revisionId.nullable(), contentVersion: integer, pages: z.array(z.strictObject({ pageId, artifactId, visibility: z.enum(['private', 'shared', 'public']), policyEpoch: integer, tombstoned: z.boolean(), route: route.nullable() })) })
const revision = z.strictObject({ revisionId, manifestSha256: z.string().regex(/^[0-9a-f]{64}$/), sealedAt: integer, previouslyActivated: z.boolean(), retention: z.enum(['retained', 'discarded', 'purged']), discardedAt: integer.nullable(), purgedAt: integer.nullable() })
const file = z.strictObject({ path, kind: z.enum(['document', 'subdocument', 'fragment', 'asset']), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: integer, contentType: z.string().min(1).max(255) })
const page = z.strictObject({ pageId, documentPath: path, metadata: z.unknown().refine(value => value !== undefined && value !== null) })
const edge = z.strictObject({ ownerPageId: pageId, path, providerArtifactId: artifactId })
const manifestBase = { artifactId, activeRevisionId: revisionId.nullable(), contentVersion: integer, revision, nextCursor: cursor }
export const manifestSchema = z.discriminatedUnion('section', [
  z.strictObject({ ...manifestBase, section: z.literal('files'), items: z.array(file).max(100) }),
  z.strictObject({ ...manifestBase, section: z.literal('pages'), items: z.array(page).max(100) }),
  z.strictObject({ ...manifestBase, section: z.literal('edges'), items: z.array(edge).max(100) }),
])
export const statusSchema = z.strictObject({ sessionId, artifactId, revisionId, baseRevisionId: revisionId.nullable(), expiresAt: integer, state: z.enum(['open', 'sealed', 'committed', 'closed']), files: z.array(z.strictObject({ path, source: z.enum(['client', 'base']), stored: z.boolean() })).max(10000) })
export const uploadSchema = z.strictObject({ sessionId, path, stored: z.literal(true), state: z.enum(['open', 'sealed', 'committed']) })
export const receiptSchema = z.strictObject({ artifactId, revisionId: revisionId.nullable(), contentVersion: integer, pages: z.array(z.strictObject({ pageId, url: z.string().min(1) })).max(1000) })
const enrichmentStatus = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('disabled'), reason: z.enum(['not_configured', 'not_requested']) }),
  z.strictObject({ state: z.literal('pending'), attempt: integer }),
  z.strictObject({ state: z.literal('running'), attempt: integer }),
  z.strictObject({ state: z.literal('ready'), source: z.enum(['preserved', 'generated', 'created']) }),
  z.strictObject({ state: z.literal('failed'), code: z.enum(['render_timeout', 'render_rejected', 'render_unavailable', 'integrity_error', 'shortlink_unavailable', 'shortlink_conflict', 'target_changed']), retryable: z.boolean() }),
  z.strictObject({ state: z.literal('superseded') }),
])
export const enrichmentSchema = z.strictObject({ version: z.literal(1), artifactId, revisionId, observedAt: integer, items: z.array(z.strictObject({ pageId, revisionId, og: enrichmentStatus, shortlink: enrichmentStatus })).max(100), nextCursor: cursor })
export type EnrichmentPage = z.infer<typeof enrichmentSchema>

export type ManifestPage = z.infer<typeof manifestSchema>