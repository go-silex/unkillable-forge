import { createRemoteJWKSet, jwtVerify } from 'jose';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

// Cache signing keys only, never assertions, identities or authorization decisions.
const keySets = new Map();

// Temporary, stateless receiver. The Access application must cover ALL methods on /mcp.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.EXPECTED_HOST || url.host !== env.EXPECTED_HOST || url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (request.headers.has('origin')) return new Response('Origin not allowed', { status: 403 });
    if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return new Response('Access configuration missing', { status: 503 });
    const assertion = request.headers.get('cf-access-jwt-assertion');
    if (!assertion) return new Response('Access assertion required', { status: 401 });
    let identity;
    try {
      const issuer = new URL(env.TEAM_DOMAIN);
      if (issuer.protocol !== 'https:' || !issuer.hostname.endsWith('.cloudflareaccess.com') || issuer.pathname !== '/' || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.port) throw Error();
      let keys = keySets.get(issuer.origin);
      if (!keys) {
        keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer));
        keySets.set(issuer.origin, keys);
      }
      const verified = await jwtVerify(assertion, keys, { issuer: issuer.origin, audience: env.POLICY_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'] });
      if (typeof verified.payload.sub !== 'string' || !verified.payload.sub || typeof verified.payload.exp !== 'number' || typeof verified.payload.iat !== 'number') throw Error();
      // JSON string encoding preserves tuple boundaries; this is a stable, linkable pseudonym.
      identity = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(['forge-f06-identity-v1', issuer.origin, verified.payload.sub]))));
    } catch { return new Response('Access assertion invalid', { status: 403 }); }
    if (request.method === 'PUT') {
      if (!request.body) return new Response('Body required', { status: 400 });
      const hash = sha256.create();
      let size = 0;
      const reader = request.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16 * 1024 * 1024) { await reader.cancel(); return new Response('File too large', { status: 413 }); }
          hash.update(value);
        }
      } catch { return new Response('Incomplete stream', { status: 400 }); }
      return Response.json({ size, sha256: bytesToHex(hash.digest()) }, { headers: { 'cache-control': 'no-store', 'x-f06-identity': identity } });
    }
    if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') return new Response('Method not allowed', { status: 405 });
    const server = new McpServer({ name: 'forge-f06-receiver', version: '0.0.0' });
    server.registerTool('receiver_info', { description: 'Authenticated receiver metadata only', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ authenticated: true, maxFileBytes: 16 * 1024 * 1024 }) }] }));
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  }
};
