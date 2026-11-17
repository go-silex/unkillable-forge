import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { setVisibility } from '../../domains/catalogue/commands'
import { shortlinkDestinationDigest } from '../../domains/catalogue/shortlinks'
import { enqueueEnrichment } from '../../domains/delivery/enrichments'
import { drainShortlinkJobs } from '../../adapters/shlink/job-drain'
import { actor, artifactId, bootstrap, configs, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'

beforeEach(async () => { await bootstrap(); await pageFixture() })
it('runs eligible jobs only under a still-authorized real actor', async () => {
  const deps = { db:env.DB, config:(await configs()).manage, jwks, now:() => 10 }
  await setVisibility(deps,actor,{ artifactId,pageId,expectedPolicyEpoch:0,visibility:'public' })
  const destination='https://forge.example.test/a/sample/'
  await enqueueEnrichment(deps,actor,{ artifactId,revisionId,pageId,expectedContentVersion:0,expectedPolicyEpoch:1,kind:'shortlink',inputSha256:'a'.repeat(64),desiredGrantId:null,mappingId:'mapping-a',providerOrigin:'https://short.example',shortDomain:'short.example',shortCode:'code-a',destinationSha256:await shortlinkDestinationDigest(destination) })
  const fetcher=vi.fn().mockResolvedValue(Response.json({shortCode:'code-a',shortUrl:'https://short.example/code-a',longUrl:destination}))
  const config={collectionUrl:'https://short.example/rest/v3/short-urls',apiKey:'test',fetch:fetcher as typeof fetch}
  await env.DB.prepare("UPDATE role_grants SET revoked_at=11,revoked_by=? WHERE principal_id=?").bind(actor.principalId,actor.principalId).run()
  expect(await drainShortlinkJobs(deps,actor,config,{limit:1,deadlineMs:1000})).toEqual({examined:0,completed:0,failed:0})
  expect(fetcher).not.toHaveBeenCalled()
  await env.DB.prepare('UPDATE role_grants SET revoked_at=NULL,revoked_by=NULL WHERE principal_id=?').bind(actor.principalId).run()
  expect(await drainShortlinkJobs(deps,actor,config,{limit:1,deadlineMs:1000,scope:{artifactId,revisionId,pageId:'other'}})).toEqual({examined:0,completed:0,failed:0})
  expect(fetcher).not.toHaveBeenCalled()
  expect(await drainShortlinkJobs(deps,actor,config,{limit:1,deadlineMs:1000})).toEqual({examined:1,completed:1,failed:0})
})
