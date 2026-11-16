import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { configProposal } from '../../plugins/unkillable-forge/src/install.js'

describe('client launch proposals', () => {
  it.each(['claude-code', 'omp'] as const)('isolates %s child environment without altering the host', client => {
    const patch = JSON.parse(configProposal({ client, name: 'forge-test', profile: '/tmp/profile.json', stateDir: '/tmp/state', node: '/usr/bin/node', bundle: '/tmp/forge.js', home: '/tmp/home' }))
    const entry = patch.mcpServers['forge-test']
    expect(entry.cwd).toBeUndefined()
    const prefix = entry.args.slice(0, 4)
    const child = spawnSync(entry.command, [...prefix, '/usr/bin/env'], { env: { CF_API_TOKEN: 'must-not-inherit', PATH: process.env.PATH }, encoding: 'utf8' })
    expect(child.status).toBe(0)
    expect(child.stdout).not.toContain('CF_API_TOKEN')
    expect(child.stdout).toContain('HOME=/tmp/home')
  })
  it('emits an isolated Codex entry without inherited provider credentials', () => {
    const proposal = configProposal({ client: 'codex', name: 'forge-test', profile: '/tmp/profile.json', stateDir: '/tmp/state', node: '/usr/bin/node', bundle: '/tmp/forge.js', home: '/tmp/home' })
    expect(proposal).toContain('[mcp_servers.forge-test]')
    const encoded = proposal.match(/^args = (.+)$/m)?.[1]
    expect(encoded).toBeDefined()
    const args: string[] = JSON.parse(encoded!)
    const child = spawnSync('/usr/bin/env', [...args.slice(0, 4), '/usr/bin/env'], { env: { CF_API_TOKEN: 'must-not-inherit', OPENAI_API_KEY: 'must-not-inherit' }, encoding: 'utf8' })
    expect(child.status).toBe(0)
    expect(child.stdout).not.toContain('CF_API_TOKEN')
    expect(child.stdout).not.toContain('OPENAI_API_KEY')
  })
  it('rejects relative paths', () => {
    expect(() => configProposal({ client: 'codex', name: 'forge', profile: './profile', stateDir: '/tmp/state', node: '/usr/bin/node', bundle: '/tmp/forge.js', home: '/tmp/home' })).toThrow('absolute_path_required')
  })
})
