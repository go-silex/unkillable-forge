import { isAbsolute, join } from 'node:path'
import type { NativeClient } from './profile.js'

export interface ProposalInput {
  name: string
  client: NativeClient
  profile: string
  stateDir: string
  node: string
  bundle: string
  home: string
}

export function configProposal(input: ProposalInput): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.name)) throw new Error('invalid_server_name')
  for (const value of [input.profile, input.stateDir, input.node, input.bundle, input.home]) {
    if (!isAbsolute(value) || value.includes('\0') || value.includes('\n')) throw new Error('absolute_path_required')
  }
  const args = [ '-i', 'PATH=/usr/bin:/bin', `HOME=${input.home}`, `XDG_CACHE_HOME=${join(input.home, '.cache')}`, input.node, input.bundle, 'stdio', '--profile', input.profile, '--client', input.client, '--state-dir', input.stateDir ]
  if (input.client === 'codex') {
    return `[mcp_servers.${input.name}]\ncommand = "/usr/bin/env"\nargs = ${JSON.stringify(args)}\n`
  }
  const entry = { command: '/usr/bin/env', args }
  return JSON.stringify({ mcpServers: { [input.name]: entry } }, null, 2)
}
