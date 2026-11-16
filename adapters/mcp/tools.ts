import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Runtime } from '../http/manage-config'
import { publicError } from '../http/manage-edge'
import { InputError } from '../http/publication-input'
import type { ManageActor } from '../../domains/catalogue/principals'
import { readPagePolicy, setVisibility, share, rotateShare, revokeShare, revealShare } from '../../domains/catalogue/commands'
import { listManagedCatalogue, getManagedPage } from '../../domains/catalogue/managed-state'
import { readArtifactState, readManifest, readRevisions } from '../../domains/publication/state'

const id = z.string()
const integer = z.number().int().safe()
const target = { pageId: id, artifactId: id, expectedPolicyEpoch: integer }
const grant = z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('follow_active') }), z.strictObject({ mode: z.literal('pinned'), revisionId: id })])
const file = z.strictObject({ path: id, kind: z.enum(['document', 'subdocument', 'fragment', 'asset']), sha256: id, size: integer, contentType: id, source: z.enum(['client', 'base']) })
const page = z.strictObject({ pageId: id, disposition: z.enum(['new', 'keep', 'drop', 'restore']), documentPath: id.nullable(), metadata: z.unknown(), expectedPolicyEpoch: integer.nullable() })
const edge = z.strictObject({ ownerPageId: id, path: id, providerArtifactId: id.nullable() })
const promotion = { idempotencyKey: id, artifactId: id, expectedContentVersion: integer }
const session = z.strictObject({ sessionId: id })
const paging = { cursor: id.nullable().optional(), limit: integer.optional() }

export function registerTools(server: McpServer, runtime: Runtime, actor: ManageActor) {
  const { deps, service } = runtime
  function tool<T>(name: string, description: string, schema: z.ZodType<T>, run: (input: T) => Promise<unknown>) {
    server.registerTool(name, { description, inputSchema: schema }, async (input) => {
      try {
        const result = await run(input as T)
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, result: result ?? null }) }] }
      } catch (error) {
        const fault = publicError(error)
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: fault.code } }) }] }
      }
    })
  }
  tool('forge_catalogue', 'List accessible current pages, including tombstones.', z.strictObject(paging), x => listManagedCatalogue(deps, actor, x))
  tool('forge_page', 'Look up an accessible current page, including tombstones.', z.strictObject({ pageId: id }), x => getManagedPage(deps, actor, x.pageId))
  tool('forge_page_policy', 'Read current page policy and grant metadata.', z.strictObject({ pageId: id }), x => readPagePolicy(deps, actor, x.pageId))
  tool('forge_artifact_state', 'Read current scoped artifact state and CAS inputs.', z.strictObject({ artifactId: id }), x => readArtifactState(deps, actor, x))
  tool('forge_manifest', 'Read one consistent page of a revision manifest.', z.strictObject({ artifactId: id, revisionId: id.nullable().optional(), section: z.enum(['files', 'pages', 'edges']), ...paging }), x => readManifest(deps, actor, x))
  tool('forge_revisions', 'Read retained and discarded revision metadata.', z.strictObject({ artifactId: id, ...paging }), x => readRevisions(deps, actor, x))
  tool('forge_begin', 'Begin publication with metadata only; upload bytes separately.', z.strictObject({ command: z.strictObject({ idempotencyKey: id, artifactId: id.nullable(), expectedRevisionId: id.nullable(), expectedContentVersion: integer, files: z.array(file), pages: z.array(page), edges: z.array(edge) }) }), async x => {
    if (x.command.files.some(f => f.size > runtime.transport.maxUploadBytes)) throw new InputError('payload_too_large')
    return service.begin(actor, x.command)
  })
  tool('forge_materialize', 'Copy a base revision file into a publication.', z.strictObject({ sessionId: id, path: id }), x => service.materialize(actor, x.sessionId, x.path))
  tool('forge_seal', 'Seal a complete publication.', session, x => service.seal(actor, x.sessionId))
  tool('forge_commit', 'Commit a sealed publication.', session, x => service.commit(actor, x.sessionId))
  tool('forge_status', 'Read publication session status.', session, x => service.status(actor, x.sessionId))
  tool('forge_abort', 'Abort a publication session.', session, x => service.abort(actor, x.sessionId))
  tool('forge_restore', 'Restore a previously committed revision using CAS.', z.strictObject({ command: z.strictObject({ ...promotion, revisionId: id }) }), x => service.restore(actor, x.command))
  tool('forge_unpublish', 'Unpublish using CAS.', z.strictObject({ command: z.strictObject(promotion) }), x => service.unpublish(actor, x.command))
  tool('forge_upload_descriptor', 'Describe the authenticated byte upload endpoint for an existing session.', z.strictObject({ sessionId: id, path: id }), async x => {
    const status = await service.status(actor, x.sessionId)
    if (!status.files.some(f => f.path === x.path && f.source === 'client')) throw new InputError('invalid_request')
    const query = new URLSearchParams({ sessionId: x.sessionId, path: x.path })
    return { method: 'PUT', url: `https://${deps.config.manageHost}/api/publication/upload?${query}`, contentType: 'application/octet-stream' }
  })
  tool('forge_visibility', 'Set page visibility.', z.strictObject({ ...target, visibility: z.enum(['private', 'public']) }), x => setVisibility(deps, actor, x))
  tool('forge_share', 'Create a page share grant.', z.strictObject({ ...target, grant }), x => share(deps, actor, { pageId: x.pageId, artifactId: x.artifactId, expectedPolicyEpoch: x.expectedPolicyEpoch, ...x.grant }))
  tool('forge_rotate_share', 'Rotate an existing share grant.', z.strictObject({ ...target, grantId: id, next: grant.optional() }), x => rotateShare(deps, actor, x))
  tool('forge_revoke_share', 'Revoke a share grant.', z.strictObject({ ...target, grantId: id }), x => revokeShare(deps, actor, x))
  tool('forge_reveal_share', 'Reveal a revealable share key.', z.strictObject({ ...target, grantId: id }), x => revealShare(deps, actor, x))
}
