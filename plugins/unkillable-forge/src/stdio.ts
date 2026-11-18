import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { loadProfile, type NativeClient } from './profile.js'
import { ForgeAuth } from './auth.js'
import { LocalPublisher } from './publisher.js'
import { Remote } from './remote.js'
import { configProposal } from './install.js'

const source = z.strictObject({ rootId: z.string().min(1), relativePath: z.string().min(1) })
const mapping = z.strictObject({ source, path: z.string(), kind: z.enum(['document', 'subdocument', 'fragment', 'asset']), contentType: z.string() })
const change = z.strictObject({ pageId: z.string(), disposition: z.enum(['new', 'keep', 'drop', 'restore']), documentPath: z.string().nullable(), metadata: z.unknown() })
const ownership = z.strictObject({ action: z.enum(['add', 'remove']), ownerPageId: z.string(), path: z.string(), providerArtifactId: z.string().nullable() })
const baseline = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('explicit'), expected: z.strictObject({ artifactId: z.string(), expectedRevisionId: z.string().nullable(), expectedContentVersion: z.number().int().nonnegative() }) }), z.strictObject({ kind: z.literal('checkpoint'), checkpointId: z.string() })])
const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new'), route: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('subtree'), slug: z.string() }), z.strictObject({ kind: z.literal('tree_page'), pageRef: z.string() })]) }),
  z.strictObject({ kind: z.literal('existing'), baseline, changes: z.strictObject({ upserts: z.array(mapping), pageChanges: z.array(change), removeResourcePaths: z.array(z.string()), ownershipChanges: z.array(ownership) }) }),
])
const publishSchema = z.strictObject({ source, target, metadata: z.record(z.string(), z.unknown()), manifestPath: source.optional() })
const operationSchema = z.strictObject({ operationId: z.string() })
const allowedRemote = new Set(['forge_catalogue', 'forge_page', 'forge_page_policy', 'forge_artifact_state', 'forge_manifest', 'forge_revisions', 'forge_visibility', 'forge_share', 'forge_rotate_share', 'forge_revoke_share', 'forge_reveal_share', 'forge_restore', 'forge_unpublish', 'forge_enrichments', 'forge_retry_enrichments'])

async function serve(profilePath: string, client: NativeClient, stateDir: string) {
  const profile = await loadProfile(profilePath)
  const auth = new ForgeAuth(profile, client, stateDir)
  const remote = new Remote(profile, auth)
  await remote.connect()
  const profileFingerprint = createHash('sha256').update(JSON.stringify({ profile, client })).digest('hex')
  const publisher = new LocalPublisher({ transport: remote, roots: profile.roots, stateDir, profileFingerprint, readOrigin: profile.readOrigin })
  const local: Tool[] = [
    { name: 'forge_publish', description: 'Publish local path metadata without placing file bytes in model context.', inputSchema: z.toJSONSchema(publishSchema) as Tool['inputSchema'] },
    ...['forge_resume', 'forge_operation_status', 'forge_abort_operation'].map(name => ({ name, description: 'Manage a local durable publication operation.', inputSchema: z.toJSONSchema(operationSchema) as Tool['inputSchema'] })),
  ]
  const remoteTools = remote.listTools().filter(tool => allowedRemote.has(tool.name))
  const server = new Server({ name: 'unkillable-forge', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...local, ...remoteTools] }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const { name, arguments: args = {} } = request.params
      let result: unknown
      if (name === 'forge_publish') result = await publisher.publish(publishSchema.parse(args))
      else if (name === 'forge_resume') result = await publisher.resume(operationSchema.parse(args).operationId)
      else if (name === 'forge_operation_status') result = await publisher.status(operationSchema.parse(args).operationId)
      else if (name === 'forge_abort_operation') { await publisher.abort(operationSchema.parse(args).operationId); result = null }
      else if (allowedRemote.has(name) && remoteTools.some(tool => tool.name === name)) result = await remote.call(name, args)
      else throw new Error('unsupported_tool')
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, result }) }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const code = /^[a-z_]{1,64}$/.test(message) ? message : 'operation_failed'
      const operationId = error && typeof error === 'object' && 'operationId' in error && typeof error.operationId === 'string' && /^[0-9a-f-]{36}$/.test(error.operationId) ? error.operationId : undefined
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code, ...(operationId ? { operationId } : {}) } }) }] }
    }
  })
  await server.connect(new StdioServerTransport())
}

async function main() {
  const [command, ...tokens] = process.argv.slice(2)
  const flags = new Map<string, string>()
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i], value = tokens[i + 1]
    if (!flag?.startsWith('--') || !value || flags.has(flag)) throw new Error('invalid_arguments')
    flags.set(flag, value)
  }
  const required = (name: string) => { const value = flags.get(name); if (!value) throw new Error('invalid_arguments'); return value }
  if (!['stdio', 'profile-check', 'connect', 'config-proposal'].includes(command)) throw new Error('invalid_arguments')
  const valid = command === 'config-proposal' ? ['--profile', '--client', '--state-dir', '--name', '--node', '--bundle', '--home'] : ['--profile', '--client', '--state-dir']
  if ([...flags.keys()].some(key => !valid.includes(key))) throw new Error('invalid_arguments')
  const profilePath = required('--profile'), stateDir = required('--state-dir'), client = required('--client')
  if (!isAbsolute(profilePath) || !isAbsolute(stateDir) || !['claude-code', 'codex', 'omp'].includes(client)) throw new Error('invalid_arguments')
  const nativeClient = client as NativeClient
  const profile = await loadProfile(profilePath)
  if (command === 'profile-check') { console.log(JSON.stringify({ ok: true, profileId: profile.profileId, instanceId: profile.instanceId })); return }
  if (command === 'config-proposal') {
    console.log(configProposal({ client: nativeClient, profile: profilePath, stateDir, name: required('--name'), node: required('--node'), bundle: required('--bundle'), home: required('--home') }))
    return
  }
  if (command === 'connect') {
    const auth = new ForgeAuth(profile, nativeClient, stateDir)
    await auth.connect(url => process.stderr.write(`Open this authorization URL in your browser:\n${url}\n`))
    process.stderr.write('Authorization completed.\n')
    return
  }
  await serve(profilePath, nativeClient, stateDir)
}
main().catch(error => {
  const message = error instanceof Error ? error.message : ''
  process.stderr.write(`${/^[a-z_]{1,64}$/.test(message) ? message : 'operation_failed'}\n`)
  process.exitCode = 1
})
