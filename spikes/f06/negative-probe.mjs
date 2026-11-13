// Operator-only: run against explicitly approved, freshly isolated test apps only.
import { createHash } from 'node:crypto';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClient } from './oauth.mjs';
import { SpikeFailure } from './errors.mjs';

const mode = process.argv[2];
if (!['wrong-verifier', 'wrong-resource'].includes(mode) || process.argv.length !== 3) throw Error('Choose wrong-verifier or wrong-resource');
if (process.env.F06_NEGATIVE_APPROVED !== 'yes') throw Error('Explicit test-app approval required');
function approvedResource(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw Error('A valid approved HTTPS /mcp resource is required');
  return url;
}
const target = approvedResource(process.env.F06_RESOURCE);
const other = mode === 'wrong-resource' ? approvedResource(process.env.F06_OTHER_RESOURCE) : undefined;
if (other && !process.env.F06_OTHER_AUTH_ISSUER) throw Error('F06_OTHER_AUTH_ISSUER must be independently observed for the second test app');
if (other && (process.env.F06_OTHER_APPROVED !== 'yes' || other.origin === target.origin)) throw Error('A distinct approved second test host, app and Worker are required');
class WrongVerifierClient extends OAuthClient {
  codeVerifier() { return 'A'.repeat(64); }
}
const client = mode === 'wrong-verifier'
  ? new WrongVerifierClient(target, 'negative-wrong-verifier')
  : new OAuthClient(other, 'negative-wrong-resource', process.env.F06_OTHER_AUTH_ISSUER);
await client.load();
if (client.data.tokens || client.data.client) throw Error('Negative probe needs a fresh isolated profile; do not reuse grants');
const signal = new AbortController().signal;
const body = Buffer.from('forge-f06-synthetic-control\n', 'utf8');
const digest = createHash('sha256').update(body).digest('hex');
async function put(resource, token) {
  return fetch(resource, { method: 'PUT', redirect: 'manual', credentials: 'omit', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body, signal });
}
async function validateReceiptResponse(response) {
  const identity = response.headers.get('x-f06-identity');
  if (!response.ok || !/^[0-9a-f]{64}$/.test(identity || '')) { await response.body?.cancel(); return undefined; }
  try { const receipt = await response.json(); return receipt.size === body.length && receipt.sha256 === digest ? identity : undefined; } catch { return undefined; }
}
async function validReceiver(resource, token) {
  return validateReceiptResponse(await put(resource, token));
}
function accessChallenge(response, resource) {
  if (response.status !== 401 || !/^\s*Bearer(?:\s|$)/i.test(response.headers.get('www-authenticate') || '')) return false;
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
  return Boolean(resourceMetadataUrl && resourceMetadataUrl.protocol === 'https:' && resourceMetadataUrl.origin === resource.origin && !resourceMetadataUrl.username && !resourceMetadataUrl.password && !resourceMetadataUrl.search && !resourceMetadataUrl.hash);
}
try {
  const result = await client.ensure(signal);
  if (mode === 'wrong-verifier') {
    console.log(JSON.stringify({ mode, result: 'unexpected_success', interpretation: 'wrong verifier accepted; revoke only this isolated grant with owner approval' }));
    process.exitCode = 1;
  } else {
    if (!process.env.F06_CONTROL_PROFILE) throw new SpikeFailure('probe', 'CONTROL_PROFILE_REQUIRED');
    const control = new OAuthClient(target, process.env.F06_CONTROL_PROFILE);
    await control.load();
    const targetAuth = await control.ensure(signal, 'noninteractive');
    const otherAccepted = await validReceiver(other, result.token);
    const targetBefore = await validReceiver(target, targetAuth.token);
    const response = await put(target, result.token);
    const targetHttpStatus = response.status;
    const challenged = accessChallenge(response, target);
    const foreignIdentity = await validateReceiptResponse(response);
    const targetAfter = await validReceiver(target, targetAuth.token);
    const samePrincipal = Boolean(otherAccepted && targetBefore && targetAfter && otherAccepted === targetBefore && targetBefore === targetAfter);
    const foreignAccepted = Boolean(samePrincipal && foreignIdentity === targetBefore);
    const verdict = samePrincipal && challenged ? 'wrong_resource_token_rejected' : foreignAccepted ? 'wrong_resource_token_accepted' : 'inconclusive';
    console.log(JSON.stringify({ mode, result: verdict, otherAccepted: Boolean(otherAccepted), targetBefore: Boolean(targetBefore), targetAfter: Boolean(targetAfter), samePrincipal, foreignAccepted, targetHttpStatus, accessChallenge: challenged }));
    process.exitCode = verdict === 'wrong_resource_token_rejected' ? 0 : 1;
  }
} catch (error) {
  const known = error instanceof SpikeFailure;
  const evidence = { mode, result: 'inconclusive', code: known ? error.code : 'FAILED', ...(known && error.status ? { httpStatus: error.status } : {}), ...(known && error.cachedHttpStatus ? { cachedHttpStatus: error.cachedHttpStatus } : {}), ...(known && error.oauthCode ? { oauthCode: error.oauthCode } : {}) };
  if (mode === 'wrong-verifier' && error.code === 'CODE_EXCHANGE_FAILED' && error.oauthCode === 'invalid_grant') evidence.result = 'wrong_verifier_rejected';
  console.log(JSON.stringify(evidence));
  process.exitCode = evidence.result === 'wrong_verifier_rejected' ? 0 : 1;
}
