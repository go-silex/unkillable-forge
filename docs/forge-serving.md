# Forge read serving

F05 is not a production cutover. The read Worker uses Catalogue's `resolveRead` for every request and Revision Store for the selected artefact, revision and resource path. It does not hold the share seal key or expose management commands. A missing selected object is a 404, including the OR-1 case of a public reference without bytes; it never falls back to a source hub. A metadata or Store failure is unavailable rather than a fallback.

## Browser transport

A document's opaque Catalogue proof is held in a Secure, HttpOnly, host-only `forge_pin` cookie scoped to `/_revisions/<page>/<revision>/` for at most 900 seconds. It is sent unchanged back to Catalogue; it is not an authorization credential independently of the current page visibility, grant, identity and epoch. Each revision has a separate cookie path, so tabs do not overwrite a global latest-revision value. Resources use the requesting page/revision namespace even if Catalogue selects an external provider's current revision for Store. Revocation and expiry are rechecked on every resource request.

HTML and CSS are transformed for delivery, not rewritten in R2. The original effective base and CSS URL resolve structured resource references into the reserved revision namespace; navigation remains on canonical URLs. Transformed responses use neither raw strong validators nor byte offsets. Other bytes support HEAD, single byte ranges and conditional ETags only after Catalogue authorization and an object existence/integrity check. Responses are `no-store`, `nosniff` and `no-referrer`.

Page-share browser exchanges use the legacy host-only `forge_share` cookie (`encodeURIComponent(pageRef + '|' + key)`) and Catalogue's destination. Crawler/card route decisions remain Catalogue-owned. F09 owns crawler-specific OG metadata and Shlink work; serving original document/card bytes does not invent an OG image or new grant.

The catalogue uses Catalogue's viewer and projection; management links go to the separate configured management host. Authorized navigable documents receive a page-specific management link without a share key. Known marked legacy toolbar blocks, reserved inline toolbar scripts and serialized toolbar nodes are removed from the delivered representation, not from R2. Management authenticates on its own origin and scoped controls use the same Catalogue commands as other management transports.

## Local development only

`wrangler.read.toml` and `wrangler.manage.toml` are local profiles, not deployment safeguards. Supply a private Wrangler dotenv containing validated `FORGE_INSTANCE` and `FORGE_SHARE_VERIFIER_KEYS`; management also needs its publication/transport options and optionally a seal key. Never bind a seal key to the read Worker. Use local D1 migrations and local R2 only. For example, after configuring matching local bindings and a private env file:

```sh
npx wrangler d1 migrations apply forge-manage-local --local --config wrangler.read.toml
npx wrangler dev --local --config wrangler.read.toml --env-file /path/to/private.env
npx wrangler dev --local --config wrangler.manage.toml --env-file /path/to/private-manage.env
```

Both profiles must use the same local D1/R2 state to see the same instance. Browser testing needs the configured HTTPS hostnames, trusted local HTTPS, and an actual Access-compatible signed identity/JWKS fixture; plain HTTP does not send Secure cookies. Local runs do not authorize creation of remote resources or deployment.

## Uncovered corpus

A metadata-only inspection of 203 local Unkillable HTML/JS files found 28 literal root-relative fetch references, all to the legacy share or visibility API, and two `location.href` references whose data flow is unknown. This local corpus is not evidence of published content or absence of indirect loaders. Arbitrary JavaScript is not generally rewritten. Before migration, exercise the approved real corpus against this Worker and correct demonstrated incompatibilities in their producers. Dynamic JS, remote dependencies, and historical ownership reconciliation are not covered by static HTML/CSS rewriting. No corpus replay or production switch is claimed here.
