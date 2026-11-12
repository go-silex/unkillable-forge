import { auth, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { SpikeFailure } from './errors.mjs';

export class OAuthClient {
  constructor(resource, profile) {
    this.resource = new URL(resource);
    if (this.resource.protocol !== 'https:' || this.resource.pathname !== '/mcp' || this.resource.search || this.resource.hash || this.resource.username || this.resource.password) throw Error('Resource must be an HTTPS /mcp URL');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(profile)) throw Error('Set F06_PROFILE to an isolated client name');
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
  }
  async save() {
    const temp = `${this.file}.${randomBytes(12).toString('hex')}`;
    await writeFile(temp, JSON.stringify(this.data), { mode: 0o600, flag: 'wx' });
    await rename(temp, this.file);
  }
  get clientMetadata() { return { client_name: 'Forge F06 isolated adapter', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  state() { return this.expectedState; }
  clientInformation() { return this.data.client; }
  async saveClientInformation(value) { this.data.client = value; await this.save(); }
  tokens() { return this.data.tokens; }
  async saveTokens(value) { this.data.tokens = value; await this.save(); }
  async saveCodeVerifier(value) { this.verifier = value; }
  codeVerifier() { if (!this.verifier) throw Error('PKCE verifier unavailable'); return this.verifier; }
  async invalidateCredentials(scope) { if (scope === 'all' || scope === 'client') delete this.data.client; if (scope === 'all' || scope === 'tokens') delete this.data.tokens; await this.save(); }
  async validateResourceURL(server, advertised) {
    if (!advertised || new URL(advertised).href !== this.resource.href || new URL(server).href !== this.resource.href) throw Error('Protected resource metadata does not match configured resource');
    return this.resource;
  }
  async redirectToAuthorization(url) {
    this.authorizationUrl = url;
    console.error('Authenticate in your browser at http://127.0.0.1:39875/start');
  }
  async authenticate(challenge) {
    this.expectedState = randomBytes(32).toString('base64url');
    this.authorizationUrl = undefined;
    this.verifier = undefined;
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(challenge);
    if (!resourceMetadataUrl) throw new SpikeFailure('oauth', 'RESOURCE_METADATA_MISSING', 401);
    const server = createServer();
    let resolveCallback, rejectCallback, resolveCompletion, resolvePage;
    const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const page = new Promise(resolve => { resolvePage = resolve; });
    let callbackAccepted = false;
    server.on('request', async (req, res) => {
      if (req.headers.host !== '127.0.0.1:39875' || req.method !== 'GET' || !req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400).end('Invalid request'); return; }
      const url = new URL(req.url, this.redirectUrl);
      if (url.pathname === '/start' && this.authorizationUrl && !callbackAccepted) { res.writeHead(302, { location: this.authorizationUrl.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(); return; }
      if (url.pathname === '/complete' && !url.search && callbackAccepted) {
        const success = await completion;
        res.writeHead(success ? 200 : 400, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(success ? 'Authentication complete. Return to your client.' : 'Authentication failed. Return to your client.');
        resolvePage();
        return;
      }
      if (url.pathname !== '/callback' || callbackAccepted || url.searchParams.get('state') !== this.expectedState) { res.writeHead(400).end('Invalid callback'); return; }
      const code = url.searchParams.get('code');
      callbackAccepted = true;
      res.writeHead(303, { location: '/complete', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end();
      if (!code || url.searchParams.has('error')) { rejectCallback(new SpikeFailure('oauth', 'AUTHORIZATION_DENIED')); return; }
      resolveCallback(code);
    });
    await new Promise((resolve, reject) => server.listen(39875, '127.0.0.1', resolve).once('error', reject));
    try {
      const result = await auth(this, { serverUrl: this.resource, resourceMetadataUrl });
      if (result === 'REDIRECT') {
        const child = spawn('xdg-open', ['http://127.0.0.1:39875/start'], { stdio: 'ignore', detached: true });
        child.on('error', () => {}); child.unref();
        const timer = setTimeout(() => rejectCallback(new SpikeFailure('oauth', 'CALLBACK_TIMEOUT')), 180000);
        try {
          const code = await callback;
          await auth(this, { serverUrl: this.resource, resourceMetadataUrl, authorizationCode: code });
          resolveCompletion(true);
          await Promise.race([page, new Promise(resolve => setTimeout(resolve, 5000))]);
        } catch (error) {
          resolveCompletion(false);
          if (callbackAccepted) await Promise.race([page, new Promise(resolve => setTimeout(resolve, 5000))]);
          throw error;
        } finally { clearTimeout(timer); }
      }
    } finally { server.close(); }
  }
  async ensure() {
    let response = await fetch(this.resource, { method: 'GET', redirect: 'manual', headers: this.data.tokens ? { authorization: `Bearer ${this.data.tokens.access_token}`, accept: 'text/event-stream' } : { accept: 'text/event-stream' } });
    if (response.status === 401) {
      await this.authenticate(response);
      response = await fetch(this.resource, { method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${this.data.tokens.access_token}`, accept: 'text/event-stream' } });
    }
    if ((response.status !== 405 && !response.ok) || !this.data.tokens?.access_token) throw new SpikeFailure('oauth', 'HTTP_ERROR', response.status);
    await response.body?.cancel();
    return this.data.tokens.access_token;
  }
}
