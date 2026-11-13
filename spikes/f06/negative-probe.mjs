// Operator-only: run against explicitly approved, freshly isolated test apps only.
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
try {
  // ensure() authenticates to the selected resource and confirms its token is accepted there.
  const result = await client.ensure(signal);
  if (mode === 'wrong-verifier') {
    console.log(JSON.stringify({ mode, result: 'unexpected_success', interpretation: 'wrong verifier accepted; revoke only this isolated grant with owner approval' }));
    process.exitCode = 1;
  } else {
    // Never call target.ensure(): it would reauthenticate and conceal cross-app rejection.
    const response = await fetch(target, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { authorization: `Bearer ${result.token}`, accept: 'text/event-stream' }, signal });
    const status = response.status;
    await response.body?.cancel();
    const verdict = [401, 403].includes(status) ? 'wrong_resource_token_rejected' : response.ok || status === 405 ? 'unexpected_success' : 'inconclusive';
    console.log(JSON.stringify({ mode, result: verdict, otherAccepted: true, targetHttpStatus: status }));
    process.exitCode = verdict === 'wrong_resource_token_rejected' ? 0 : 1;
  }
} catch (error) {
  const known = error instanceof SpikeFailure;
  const evidence = { mode, result: 'inconclusive', code: known ? error.code : 'FAILED', ...(known && error.status ? { httpStatus: error.status } : {}), ...(known && error.oauthCode ? { oauthCode: error.oauthCode } : {}) };
  if (mode === 'wrong-verifier' && error.code === 'CODE_EXCHANGE_FAILED' && error.oauthCode === 'invalid_grant') evidence.result = 'wrong_verifier_rejected';
  console.log(JSON.stringify(evidence));
  process.exitCode = evidence.result === 'wrong_verifier_rejected' ? 0 : 1;
}
