import { createHash, randomBytes } from 'node:crypto';
import { bindPrivateRoot, withPrivateLock, type PrivateDirectory } from './filesystem.js';
import { createServer } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata, registerClient, startAuthorization, exchangeAuthorization, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata, OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { validateProfile, type InstanceProfile, type NativeClient } from './profile.js';

const callback = 'http://127.0.0.1:39875/callback';
type Stored = { client?: OAuthClientInformationFull; tokens?: OAuthTokens; expiresAt?: number };

function endpoint(value: string | undefined, origin: string): void {
  if (!value) throw new Error('OAUTH_ENDPOINT_INVALID');
  let u: URL;
  try { u = new URL(value); } catch { throw new Error('OAUTH_ENDPOINT_INVALID'); }
  if (u.protocol !== 'https:' || u.origin !== origin || u.username || u.password || u.search || u.hash) throw new Error('OAUTH_ENDPOINT_INVALID');
}

export class ForgeAuth {
  readonly profile: InstanceProfile;
  readonly nativeClient: NativeClient;
  private readonly root: string;
  private readonly partition: string;

  constructor(profile: InstanceProfile, nativeClient: NativeClient, stateDir: string) {
    this.profile = validateProfile(profile);
    if (!['claude-code', 'codex', 'omp'].includes(nativeClient) || !isAbsolute(stateDir) || resolve(stateDir) !== stateDir) throw new Error('INVALID_AUTH_CONFIGURATION');
    this.nativeClient = nativeClient;
    this.partition = createHash('sha256').update(JSON.stringify([this.profile.profileId, this.profile.instanceId, this.profile.authProfile, nativeClient, this.profile.mcpResource, this.profile.approvedAuthorizationIssuer])).digest('hex');
    this.root = stateDir;
  }

  private async locked<T>(fn: (directory: PrivateDirectory) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const root = await bindPrivateRoot(this.root, false).catch(() => { throw new Error('UNSAFE_STATE_DIRECTORY'); });
    try {
      const locks = await root.child('locks', true);
      try {
        let acquired = false;
        try {
          return await withPrivateLock(locks, `grant-${this.partition}.lock`, { deadlineMs: Date.now() + 180_000, signal }, async () => {
            acquired = true;
            const directory = await root.child(this.partition, true);
            try { return await fn(directory); } finally { await directory.close(); }
          });
        } catch (error) {
          if (!acquired && error instanceof Error && error.message === 'lock_timeout') throw new Error('AUTH_IN_PROGRESS');
          if (!acquired && error instanceof Error && error.message === 'lock_aborted') throw new Error('AUTH_CANCELLED');
          throw error;
        }
      } finally { await locks.close(); }
    } finally { await root.close(); }
  }

  private async load(directory: PrivateDirectory): Promise<Stored> {
    try {
      const handle = await directory.open('grant.json', 'read');
      try {
        const st = await handle.stat();
        if (st.size > 65536) throw new Error('UNSAFE_AUTH_STATE');
        const data = JSON.parse(await handle.readFile('utf8')) as Stored;
        if (!data || typeof data !== 'object' || (data.client && typeof data.client.client_id !== 'string') || (data.tokens && typeof data.tokens.access_token !== 'string')) throw new Error('INVALID_AUTH_STATE');
        return data;
      } finally { await handle.close(); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('INVALID_AUTH_STATE'); }
  }

  private async save(directory: PrivateDirectory, data: Stored): Promise<void> {
    await directory.replace('grant.json', Buffer.from(JSON.stringify(data)));
  }

  private fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const value = input instanceof Request ? input.url : String(input);
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || ![this.profile.manageOrigin, this.profile.approvedEndpointOrigin].includes(u.origin)) throw new Error('OAUTH_ENDPOINT_INVALID');
    const response = await fetch(input, { ...init, redirect: 'manual', credentials: 'omit' });
    if (response.status >= 300 && response.status < 400) throw new Error('OAUTH_REDIRECT_REJECTED');
    return response;
  };

  private async discovery(): Promise<AuthorizationServerMetadata> {
    const p = this.profile;
    const resource = await discoverOAuthProtectedResourceMetadata(p.mcpResource, {}, this.fetch);
    if (resource.resource !== p.mcpResource || !resource.authorization_servers?.includes(p.approvedAuthorizationIssuer)) throw new Error('OAUTH_RESOURCE_MISMATCH');
    const metadata = await discoverAuthorizationServerMetadata(p.approvedAuthorizationIssuer, { fetchFn: this.fetch });
    if (!metadata || metadata.issuer !== p.approvedAuthorizationIssuer) throw new Error('OAUTH_ISSUER_MISMATCH');
    endpoint(metadata.authorization_endpoint, p.approvedEndpointOrigin);
    endpoint(metadata.token_endpoint, p.approvedEndpointOrigin);
    endpoint(metadata.registration_endpoint, p.approvedEndpointOrigin);
    return metadata;
  }

  async connect(onAuthorizationUrl: (url: string) => void = url => { process.stderr.write(`Open this URL in your browser: ${url}\n`); }, signal?: AbortSignal): Promise<void> {
    await this.locked(async directory => {
      try {
        const metadata = await this.discovery();
        const data = await this.load(directory);
        if (!data.client) {
          data.client = await registerClient(this.profile.approvedAuthorizationIssuer, { metadata, clientMetadata: { client_name: `Unkillable Forge ${this.nativeClient}`, redirect_uris: [callback], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }, fetchFn: this.fetch });
          if (!data.client.client_id || data.client.client_secret) throw new Error('OAUTH_CLIENT_INVALID');
          await this.save(directory, data);
        }
        const state = randomBytes(32).toString('base64url');
        const flow = await startAuthorization(this.profile.approvedAuthorizationIssuer, { metadata, clientInformation: data.client, redirectUrl: callback, state, resource: this.profile.mcpResource });
        const code = await this.receiveCode(state, flow.authorizationUrl.toString(), onAuthorizationUrl, signal);
        data.tokens = await exchangeAuthorization(this.profile.approvedAuthorizationIssuer, { metadata, clientInformation: data.client, authorizationCode: code, codeVerifier: flow.codeVerifier, redirectUri: callback, resource: this.profile.mcpResource, fetchFn: this.fetch });
        data.expiresAt = data.tokens.expires_in === undefined ? undefined : Date.now() + data.tokens.expires_in * 1000;
        await this.save(directory, data);
      } catch { throw new Error('OAUTH_CONNECT_FAILED'); }
    }, signal);
  }

  private receiveCode(state: string, url: string, notify: (url: string) => void, signal?: AbortSignal): Promise<string> {
    return new Promise((resolveCode, reject) => {
      let done = false;
      const finish = (error?: Error, code?: string) => {
        if (done) return;
        done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); server.close();
        if (error) reject(error); else resolveCode(code!);
      };
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', callback);
        if (req.method !== 'GET' || u.pathname !== '/callback' || u.searchParams.getAll('state').length !== 1 || u.searchParams.get('state') !== state || u.searchParams.getAll('code').length !== 1 || !u.searchParams.get('code') || u.searchParams.has('error')) { res.writeHead(400).end('Invalid callback'); return; }
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Authorization received. You may close this window.');
        finish(undefined, u.searchParams.get('code')!);
      });
      const abort = () => finish(new Error('AUTH_CANCELLED'));
      const timer = setTimeout(() => finish(new Error('AUTH_TIMEOUT')), 180_000);
      server.once('error', () => finish(new Error('CALLBACK_UNAVAILABLE')));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      server.listen(39875, '127.0.0.1', () => { try { notify(url); } catch { finish(new Error('AUTH_NOTIFICATION_FAILED')); } });
    });
  }

  async accessToken(): Promise<string> {
    return this.locked(async directory => {
      const data = await this.load(directory);
      if (!data.tokens) throw new Error('AUTH_CONNECT_REQUIRED');
      if (data.expiresAt !== undefined && data.expiresAt <= Date.now() + 30_000) return this.refreshLocked(directory, data);
      return data.tokens.access_token;
    });
  }

  async refresh(): Promise<string> { return this.locked(async directory => this.refreshLocked(directory, await this.load(directory))); }

  private async refreshLocked(directory: PrivateDirectory, data: Stored): Promise<string> {
    if (!data.client || !data.tokens?.refresh_token) throw new Error('AUTH_CONNECT_REQUIRED');
    try {
      const metadata = await this.discovery();
      const tokens = await refreshAuthorization(this.profile.approvedAuthorizationIssuer, { metadata, clientInformation: data.client, refreshToken: data.tokens.refresh_token, resource: this.profile.mcpResource, fetchFn: this.fetch });
      data.tokens = tokens;
      data.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
      await this.save(directory, data);
      return tokens.access_token;
    } catch { throw new Error('OAUTH_REFRESH_FAILED'); }
  }
}
