import { auth, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { SpikeFailure } from './errors.mjs';

function safeUrl(value) {
  try { const u = new URL(value); if (u.protocol !== 'https:') return 'invalid'; return `${u.origin}${u.pathname}`.slice(0, 512); } catch { return 'invalid'; }
}

export class OAuthClient {
  constructor(resource, profile, expectedIssuer = process.env.F06_AUTH_ISSUER) {
    this.resource = new URL(resource);
    if (this.resource.protocol !== 'https:' || this.resource.pathname !== '/mcp' || this.resource.search || this.resource.hash || this.resource.username || this.resource.password) throw Error('Resource must be an HTTPS /mcp URL');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(profile)) throw Error('Set F06_PROFILE to an isolated client name');
    this.expectedIssuer = new URL(expectedIssuer);
    if (this.expectedIssuer.protocol !== 'https:' || this.expectedIssuer.username || this.expectedIssuer.password || this.expectedIssuer.search || this.expectedIssuer.hash) throw Error('F06_AUTH_ISSUER must identify the approved HTTPS authorization server');
    const scope = createHash('sha256').update(`${profile}\n${this.resource.href}`).digest('hex');
    this.directory = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'forge-f06', scope);
    this.file = join(this.directory, 'oauth.json');
    this.data = {};
    this.redirectUrl = 'http://127.0.0.1:39875/callback';
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if ((this.data.tokens && !this.data.tokens.issuer) || (this.data.client && !this.data.client.issuer)) throw new SpikeFailure('oauth', 'LEGACY_CACHE_REQUIRES_OPERATOR_REMOVAL');
  }
  async writePrivate(file, value) {
    const temp = join(this.directory, randomBytes(16).toString('hex'));
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temp, join(this.directory, file));
  }
  async save() { await this.writePrivate('oauth.json', this.data); }
  async saveIdentity(value) { await this.writePrivate('identity.json', { identitySha256: value }); }
  get clientMetadata() { return { client_name: 'Forge F06 isolated adapter', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  state() { return this.expectedState; }
  clientInformation() { return this.data.client; }
  async saveClientInformation(value) { this.data.client = value; await this.save(); }
  tokens() { return this.data.tokens; }
  async saveTokens(value) { this.data.tokens = value; await this.save(); }
  async saveCodeVerifier(value) { this.verifier = value; }
  codeVerifier() { if (!this.verifier) throw new SpikeFailure('oauth', 'VERIFIER_MISSING'); return this.verifier; }
  async invalidateCredentials(scope) { if (scope === 'all' || scope === 'client') delete this.data.client; if (scope === 'all' || scope === 'tokens') delete this.data.tokens; await this.save(); }
  async validateResourceURL(server, advertised) {
    let matches = false;
    try { matches = Boolean(advertised) && new URL(advertised).href === this.resource.href && new URL(server).href === this.resource.href; } catch { /* Report an invalid advertised URL without exposing it. */ }
    if (!matches) {
      const error = new SpikeFailure('oauth', 'PRM_RESOURCE_MISMATCH'); error.resource = safeUrl(advertised); throw error;
    }
    return this.resource;
  }
  async saveDiscoveryState(state) {
    const issuer = new URL(state.authorizationServerUrl);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) throw new SpikeFailure('oauth', 'AUTHORIZATION_SERVER_INVALID');
    if (issuer.href !== this.expectedIssuer.href) throw new SpikeFailure('oauth', 'AUTHORIZATION_SERVER_MISMATCH');
    const metadata = state.authorizationServerMetadata;
    if (!metadata?.issuer || new URL(metadata.issuer).href !== this.expectedIssuer.href) throw new SpikeFailure('oauth', 'AUTHORIZATION_METADATA_ISSUER_MISMATCH');
    const authorization = new URL(metadata.authorization_endpoint);
    if (authorization.protocol !== 'https:' || authorization.origin !== issuer.origin || authorization.username || authorization.password || authorization.search || authorization.hash) throw new SpikeFailure('oauth', 'AUTHORIZATION_ENDPOINT_ORIGIN_MISMATCH');
    const methods = state.authorizationServerMetadata?.code_challenge_methods_supported;
    if (!Array.isArray(methods) || !methods.includes('S256')) throw new SpikeFailure('oauth', methods ? 'S256_NOT_ADVERTISED' : 'S256_METADATA_ABSENT');
  }
  async redirectToAuthorization(url) {
    if (this.refreshOnly) throw this.refreshFailure || new SpikeFailure('oauth', 'REFRESH_ONLY_INTERACTIVE_BLOCKED');
    this.authorizationUrl = url;
    console.error('Authenticate in your browser at http://127.0.0.1:39875/start');
  }
  async authenticate(challenge, signal, refreshOnly) {
    this.expectedState = randomBytes(32).toString('base64url');
    this.authorizationUrl = undefined; this.verifier = undefined; this.refreshOnly = refreshOnly; this.refreshFailure = undefined; this.refreshSucceeded = false; this.refreshStatus = undefined;
    if (refreshOnly && !this.data.tokens?.refresh_token) throw new SpikeFailure('oauth', 'REFRESH_TOKEN_MISSING');
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(challenge);
    if (!resourceMetadataUrl) throw new SpikeFailure('oauth', 'RESOURCE_METADATA_MISSING', 401);
    if (resourceMetadataUrl.protocol !== 'https:' || resourceMetadataUrl.origin !== this.resource.origin || resourceMetadataUrl.username || resourceMetadataUrl.password || resourceMetadataUrl.hash || resourceMetadataUrl.search) throw new SpikeFailure('oauth', 'RESOURCE_METADATA_URL_INVALID');
    const fetchFn = async (url, init = {}) => {
      if ((init.method || 'GET').toUpperCase() === 'POST') {
        const destination = new URL(url);
        if (destination.protocol !== 'https:' || destination.origin !== this.expectedIssuer.origin || destination.username || destination.password || destination.hash || destination.search) throw new SpikeFailure('oauth', 'OAUTH_ENDPOINT_ORIGIN_MISMATCH');
      }
      const params = init.body instanceof URLSearchParams ? init.body : null;
      const isRefresh = params?.get('grant_type') === 'refresh_token';
      let response;
      try { response = await fetch(url, { ...init, signal, redirect: 'manual' }); }
      catch (error) { if (isRefresh && !signal.aborted) this.refreshFailure = new SpikeFailure('oauth', 'REFRESH_NETWORK_ERROR'); throw error; }
      if (isRefresh) {
        if (response.ok) { this.refreshSucceeded = true; this.refreshStatus = response.status; }
        else {
          let oauthCode;
          try { const body = await response.clone().json(); if (['invalid_grant', 'invalid_client', 'invalid_request', 'invalid_scope', 'unauthorized_client', 'unsupported_grant_type', 'invalid_target', 'access_denied'].includes(body.error)) oauthCode = body.error; } catch { /* No recognized OAuth code advertised. */ }
          this.refreshFailure = new SpikeFailure('oauth', 'REFRESH_FAILED', response.status); this.refreshFailure.oauthCode = oauthCode;
          throw this.refreshFailure;
        }
      }
      if (params?.get('grant_type') === 'authorization_code' && !response.ok) {
        const failure = new SpikeFailure('oauth', 'CODE_EXCHANGE_FAILED', response.status);
        try { const body = await response.clone().json(); if (['invalid_grant', 'invalid_client', 'invalid_request', 'invalid_target', 'access_denied'].includes(body.error)) failure.oauthCode = body.error; } catch { /* No recognized OAuth code advertised. */ }
        throw failure;
      }
      return response;
    };
    const server = createServer();
    let resolveCallback, rejectCallback, resolveCompletion, resolvePage;
    const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    callback.catch(() => {});
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const page = new Promise(resolve => { resolvePage = resolve; });
    let callbackAccepted = false;
    server.on('request', async (req, res) => {
      if (req.headers.host !== '127.0.0.1:39875' || req.method !== 'GET' || !req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400).end('Invalid request'); return; }
      const url = new URL(req.url, this.redirectUrl);
      if (url.pathname === '/start' && this.authorizationUrl && !callbackAccepted) { res.writeHead(302, { location: this.authorizationUrl.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(); return; }
      if (url.pathname === '/complete' && !url.search && callbackAccepted) { const success = await completion; res.writeHead(success ? 200 : 400, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(success ? 'Authentication complete. Return to your client.' : 'Authentication failed. Return to your client.'); resolvePage(); return; }
      if (url.pathname !== '/callback' || callbackAccepted || url.searchParams.get('state') !== this.expectedState) { res.writeHead(400).end('Invalid callback'); return; }
      const code = url.searchParams.get('code'); callbackAccepted = true;
      res.writeHead(303, { location: '/complete', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end();
      if (!code || url.searchParams.has('error')) { rejectCallback(new SpikeFailure('oauth', 'AUTHORIZATION_DENIED')); return; }
      resolveCallback(code);
    });
    const aborted = () => rejectCallback(new SpikeFailure('oauth', 'CANCELLED'));
    signal.addEventListener('abort', aborted, { once: true });
    let timer;
    try {
      if (signal.aborted) throw new SpikeFailure('oauth', 'CANCELLED');
      await new Promise((resolve, reject) => server.listen(39875, '127.0.0.1', resolve).once('error', reject));
      const result = await auth(this, { serverUrl: this.resource, resourceMetadataUrl, fetchFn });
      if (result === 'REDIRECT') {
        const child = spawn('xdg-open', ['http://127.0.0.1:39875/start'], { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref();
        timer = setTimeout(() => rejectCallback(new SpikeFailure('oauth', 'CALLBACK_TIMEOUT')), 180000);
        const code = await callback;
        await auth(this, { serverUrl: this.resource, resourceMetadataUrl, authorizationCode: code, fetchFn });
        resolveCompletion(true);
        await Promise.race([page, new Promise(resolve => { const t = setTimeout(resolve, 5000); t.unref(); })]);
        return 'authorized';
      }
      if (!this.refreshSucceeded) throw new SpikeFailure('oauth', 'REFRESH_NOT_OBSERVED');
      return 'refreshed';
    } finally { clearTimeout(timer); resolveCompletion(false); signal.removeEventListener('abort', aborted); server.closeAllConnections(); server.close(); }
  }
  async ensure(signal, refreshOnly = false) {
    if (this.busy) throw new SpikeFailure('oauth', 'AUTH_IN_PROGRESS');
    this.busy = true;
    try {
      const headers = { accept: 'text/event-stream' };
      if (!refreshOnly && this.data.tokens) headers.authorization = `Bearer ${this.data.tokens.access_token}`;
      let response = await fetch(this.resource, { method: 'GET', redirect: 'manual', headers, signal });
      let authPath = 'cached';
      if (response.status === 401) {
        authPath = await this.authenticate(response, signal, refreshOnly);
        response = await fetch(this.resource, { method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${this.data.tokens.access_token}`, accept: 'text/event-stream' }, signal });
      } else if (refreshOnly) throw new SpikeFailure('oauth', 'REFRESH_CHALLENGE_NOT_OBSERVED', response.status);
      if ((response.status !== 405 && !response.ok) || !this.data.tokens?.access_token) throw new SpikeFailure('oauth', 'HTTP_ERROR', response.status);
      await response.body?.cancel();
      return { token: this.data.tokens.access_token, authPath, ...(authPath === 'refreshed' ? { refresh: { httpStatus: this.refreshStatus } } : this.refreshFailure && authPath === 'authorized' ? { refresh: { code: this.refreshFailure.code, httpStatus: this.refreshFailure.status, oauthCode: this.refreshFailure.oauthCode } } : {}) };
    } finally { this.busy = false; }
  }
}
