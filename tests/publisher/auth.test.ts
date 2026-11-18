import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, chmod, link, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForgeAuth } from '../../plugins/unkillable-forge/src/auth.js';
import { validateProfile } from '../../plugins/unkillable-forge/src/profile.js';

const profile = {
  schemaVersion: 1, profileId: 'test', instanceId: 'one',
  readOrigin: 'https://read.example', manageOrigin: 'https://manage.example',
  mcpResource: 'https://manage.example/mcp', approvedAuthorizationIssuer: 'https://issuer.example',
  approvedEndpointOrigin: 'https://issuer.example', roots: [{ id: 'docs', absolutePath: '/tmp/docs' }], authProfile: 'local',
};
const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function stateDir() { const dir = await mkdtemp(join(tmpdir(), 'forge-auth-')); directories.push(dir); return dir; }

async function seedGrant(dir: string, nativeClient: string, expiresAt: number) {
  const partition = createHash('sha256').update(JSON.stringify([profile.profileId, profile.instanceId, profile.authProfile, nativeClient, profile.mcpResource, profile.approvedAuthorizationIssuer])).digest('hex');
  const path = join(dir, partition);
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, 'grant.json'), JSON.stringify({
    client: { client_id: 'client-one' },
    tokens: { access_token: 'old-access', token_type: 'Bearer', refresh_token: 'old-refresh' },
    expiresAt,
  }), { mode: 0o600 });
  return join(path, 'grant.json');
}

describe('isolated Forge OAuth', () => {
  it('requires an explicit resource, distinct origins and safe roots', () => {
    expect(validateProfile(profile).mcpResource).toBe(profile.mcpResource);
    for (const patch of [
      { readOrigin: profile.manageOrigin }, { mcpResource: 'https://other.example/mcp' },
      { approvedAuthorizationIssuer: 'https://issuer.example/?secret=x' },
      { approvedEndpointOrigin: 'https://other.example' },
      { roots: [{ id: 'docs', absolutePath: '../outside' }] },
    ]) expect(() => validateProfile({ ...profile, ...patch })).toThrow('INVALID_PROFILE');
  });

  it('rejects unsafe state and never falls back to another grant', async () => {
    const dir = await stateDir();
    const auth = new ForgeAuth(validateProfile(profile), 'omp', dir);
    await expect(auth.accessToken()).rejects.toThrow('AUTH_CONNECT_REQUIRED');
    await chmod(dir, 0o755);
    await expect(auth.accessToken()).rejects.toThrow('UNSAFE_STATE_DIRECTORY');
    await chmod(dir, 0o700);
    const link = `${dir}-link`;
    await symlink(dir, link); directories.push(link);
    await expect(new ForgeAuth(validateProfile(profile), 'omp', link).accessToken()).rejects.toThrow('AUTH_CONNECT_REQUIRED');
  });

  it('rejects hard-linked grant files', async () => {
    const dir = await stateDir();
    const grant = await seedGrant(dir, 'omp', Date.now() + 600_000);
    await link(grant, join(dir, 'other-link'));
    await expect(new ForgeAuth(validateProfile(profile), 'omp', dir).accessToken()).rejects.toThrow('INVALID_AUTH_STATE');
  });

  it('rejects a symlinked grant without reading its target', async () => {
    const dir = await stateDir();
    const grant = await seedGrant(dir, 'omp', Date.now() + 600_000);
    const target = join(dir, 'outside.json');
    await writeFile(target, 'sentinel', { mode: 0o600 });
    await rm(grant);
    await symlink(target, grant);
    await expect(new ForgeAuth(validateProfile(profile), 'omp', dir).accessToken()).rejects.toThrow('INVALID_AUTH_STATE');
    expect(await readFile(target, 'utf8')).toBe('sentinel');
  });

  it('rejects a protected-resource echo mismatch before registration', async () => {
    const dir = await stateDir();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ resource: 'https://other.example/mcp', authorization_servers: [profile.approvedAuthorizationIssuer] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new ForgeAuth(validateProfile(profile), 'codex', dir).connect()).rejects.toThrow('OAUTH_CONNECT_FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched issuer metadata before registration', async () => {
    const dir = await stateDir();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('manage.example')
        ? { resource: profile.mcpResource, authorization_servers: [profile.approvedAuthorizationIssuer] }
        : { issuer: 'https://other.example', authorization_endpoint: 'https://issuer.example/authorize', token_endpoint: 'https://issuer.example/token', registration_endpoint: 'https://issuer.example/register', response_types_supported: ['code'] };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new ForgeAuth(validateProfile(profile), 'claude-code', dir).connect()).rejects.toThrow('OAUTH_CONNECT_FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects authorization endpoints outside the independently approved origin', async () => {
    const dir = await stateDir();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('manage.example')
        ? { resource: profile.mcpResource, authorization_servers: [profile.approvedAuthorizationIssuer] }
        : { issuer: profile.approvedAuthorizationIssuer, authorization_endpoint: 'https://attacker.example/authorize', token_endpoint: 'https://issuer.example/token', registration_endpoint: 'https://issuer.example/register', response_types_supported: ['code'] };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new ForgeAuth(validateProfile(profile), 'omp', dir).connect()).rejects.toThrow('OAUTH_CONNECT_FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('refuses discovery redirects instead of following them', async () => {
    const dir = await stateDir();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 302, headers: { location: 'https://attacker.example/metadata' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new ForgeAuth(validateProfile(profile), 'omp', dir).connect()).rejects.toThrow('OAUTH_CONNECT_FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
  });

  it('partitions grants by native client and profile identity', async () => {
    const dir = await stateDir();
    await seedGrant(dir, 'omp', Date.now() + 600_000);
    await expect(new ForgeAuth(validateProfile(profile), 'omp', dir).accessToken()).resolves.toBe('old-access');
    await expect(new ForgeAuth(validateProfile(profile), 'codex', dir).accessToken()).rejects.toThrow('AUTH_CONNECT_REQUIRED');
    await expect(new ForgeAuth(validateProfile({ ...profile, profileId: 'other' }), 'omp', dir).accessToken()).rejects.toThrow('AUTH_CONNECT_REQUIRED');
  });

  it('serializes concurrent expired-token refresh and persists the rotated grant', async () => {
    const dir = await stateDir();
    const path = await seedGrant(dir, 'omp', Date.now() - 1);
    let exchanges = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      let body: object;
      if (url.includes('manage.example')) {
        body = { resource: profile.mcpResource, authorization_servers: [profile.approvedAuthorizationIssuer] };
      } else if (url.endsWith('/token')) {
        exchanges++;
        expect(String(init?.body)).toContain('refresh_token=old-refresh');
        body = { access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 };
      } else {
        body = { issuer: profile.approvedAuthorizationIssuer, authorization_endpoint: 'https://issuer.example/authorize', token_endpoint: 'https://issuer.example/token', registration_endpoint: 'https://issuer.example/register', response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'] };
      }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = new ForgeAuth(validateProfile(profile), 'omp', dir);
    const second = new ForgeAuth(validateProfile(profile), 'omp', dir);
    await expect(Promise.all([first.accessToken(), second.accessToken()])).resolves.toEqual(['new-access', 'new-access']);
    expect(exchanges).toBe(1);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    expect(persisted.tokens.refresh_token).toBe('new-refresh');
    await expect(new ForgeAuth(validateProfile(profile), 'omp', dir).accessToken()).resolves.toBe('new-access');
  });
});
