# Forge read serving

F05 is not a production cutover. The read Worker uses Catalogue's `resolveRead` for every request and Revision Store for the selected artefact, revision and resource path. It does not hold the share seal key or expose management commands. A missing selected object is a 404, including the OR-1 case of a public reference without bytes; it never falls back to a source hub. A metadata or Store failure is unavailable rather than a fallback.

## Browser transport

A document's opaque Catalogue proof is held in a Secure, HttpOnly, host-only `forge_pin` cookie scoped to `/_revisions/<page>/<revision>/` for at most 900 seconds. It is sent unchanged back to Catalogue; it is not an authorization credential independently of the current page visibility, grant, identity and epoch. Each revision has a separate cookie path, so tabs do not overwrite a global latest-revision value. Resources use the requesting page/revision namespace even if Catalogue selects an external provider's current revision for Store. Revocation and expiry are rechecked on every resource request.

HTML and CSS are transformed for delivery, not rewritten in R2. The original effective base and CSS URL resolve structured resource references into the reserved revision namespace; navigation remains on canonical URLs except that navigation within a keyed slug share retains its authorized keyed prefix. Configured canonical and alias hosts are treated as the same read instance; fixed shell paths retain their ordinary routes. SVG resource links are included. Transformed stylesheets cannot retain an integrity assertion for their original bytes. Declared text encodings are decoded for rewriting and the transformed representation is labelled UTF-8; unsupported or invalid encodings fail closed. Transformed responses use neither raw strong validators nor byte offsets. Other bytes support HEAD, single GET byte ranges and conditional ETags only after Catalogue authorization and an object existence/integrity check. Responses are `no-store`, `nosniff` and `no-referrer`; keyed and grant-backed responses carry `noindex, nofollow, noarchive`. A single finalizer classifies the request path: revision namespace when the percent-decoded first segment is `_revisions` (independent of a malformed suffix), or shell when the fully normalized path is in the reader-profile `shellPaths` (available even when DB/R2/bundle composition fails). Matching responses always get `x-robots-tag: noindex, nofollow, noarchive`; canonical publication URLs stay unmarked.

Inline stylesheet serialization preserves the enclosing HTML raw-text boundary without changing CSS string values. HTML charset selection ignores comments and unrelated meta attributes rather than matching arbitrary source substrings. HTTP and `http-equiv` media-type parameters share quote-aware parsing: quoted data does not select an encoding, and unrelated parameter values are preserved. Transformed HEAD responses advertise the same UTF-8 representation type as GET, and read-side 405 responses advertise `GET, HEAD`.

Follow-active page-share browser exchanges use the legacy host-only `forge_share` cookie (`encodeURIComponent(pageRef + '|' + key)`) and Catalogue's destination. Pinned page grants remain at their keyed URL rather than being exchanged for a follow-active-only cookie. Crawler/card route decisions remain Catalogue-owned. F09 owns crawler-specific OG metadata and Shlink work; serving original document/card bytes does not invent an OG image or new grant.

The catalogue uses Catalogue's viewer and projection; management links go to the separate configured management host. Authorized navigable documents receive a page-specific management link without a share key. Known marked legacy toolbar blocks, the exact shipped unmarked inline toolbar paired with its standalone JSON configuration, and serialized toolbar nodes are removed from the delivered representation, not from R2. Arbitrary scripts mentioning legacy names are not removed; other unmarked historical toolbar variants require corpus verification. Management authenticates on its own origin and scoped controls use the same Catalogue commands as other management transports. Management documents use `Referrer-Policy: same-origin` so browser form submissions carry the exact Origin required by the CSRF guard; the read origin remains `no-referrer`.

## Fixed instance shell

`createReadWorker` receives an explicit fixed-file map at composition. Every configured `shellPaths` entry must have either the dynamic root/index/login implementation or a supplied body and MIME type. Unknown keys and dynamic-route overrides are rejected; missing fixed bytes make the runtime unavailable, never an empty response, another instance's branding or an artefact fallback. Catalogue still performs host, method, path and D1 instance admission before any shell representation is served.

`adapters/http/unkillableReadWorker.ts` selects the genuine public icons and robots file from `site/` through native Data/Text imports. `/index.html` renders the current catalogue UI, not the old generated HTML. `wrangler.read.toml` selects this entry for local development. The generic entry does not silently select public branding. F12 must supply genuine Roxabi files through its downstream composition; incomplete private packaging is rejected and private shell parity is not claimed here. Fixed application packaging is separate from published artefact bytes in R2.

The native local public-entry smoke compared GET bytes, SHA-256, MIME and bodyless HEAD for all four genuine files, plus the current index UI and an alias-host icon. Isolated Chrome exercised anonymous/team access, a read-only local corpus sample, distinct tab pins, real share/revoke forms and public/private transitions. Synthetic local identities are not production Access or three-client publication evidence; the published corpus and live shortlinks remain migration work.

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
