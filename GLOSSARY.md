# Forge

Forge publishes a team's HTML artefacts for one instance, decides who may read each page, and serves them at stable addresses.

## Language

### Deployment

**Instance**:
One running Forge with its own hosts, identities, catalogue, rights and storage. Instances share the engine, never data.
_Avoid_: tenant, brand engine, site

**Engine**:
The common code every instance runs.
_Avoid_: forge (for the code), plugin

**Read origin**:
The historical host where readers open artefacts, plus its aliases.
_Avoid_: public host

**Management origin**:
The separate host where publishing, sharing and roles are changed.
_Avoid_: admin page, toolbar

**Deploy**:
Installing a version of the engine on an instance. Never changes content.
_Avoid_: publish (for engine releases)

### Content

**Artefact**:
A unit of publication: one or more pages and the resources they need, versioned together.
_Avoid_: project, deck (for the unit), slug

**Revision**:
An immutable, sealed version of an artefact.
_Avoid_: snapshot, deployment, version (alone)

**Active revision**:
The revision of an artefact that readers currently get.
_Avoid_: latest, live deploy

**Publication**:
Making a sealed revision the active one.
_Avoid_: deploy, upload

**Page**:
A navigable document with its own address, visibility and grants. The unit of access.
_Avoid_: file, HTML, slug

**Resource**:
Any file a revision contains: a document, subdocument, fragment or asset.

**Document**:
The entry file of a page.

**Subdocument**:
A further navigable file inside a page's subtree, governed by that page.

**Fragment**:
An HTML part loaded by pages, never served as a page.
_Avoid_: partial page

**Asset**:
A non-HTML resource such as a style, script, image or data file.

**Ownership**:
A declared relation by which a page's revision uses a fragment or asset, naming the artefact that provides it. A reader gets a fragment or asset only through a page that owns it, and only from that provider.
_Avoid_: proximity, guessed reference

**Unpublish**:
Removing a page from reading; its grants end and its address is freed.
_Avoid_: delete (bytes are retained)

**Restore**:
Making a retained revision active again. Its unpublished pages return under the same page IDs, private, with no grant, at their former address. If that address was claimed meanwhile, the whole restore fails and nothing changes.
_Avoid_: undo, undelete, rollback (for the grants)

### Addresses

**Page ID**:
The opaque, permanent identifier of a page, never derived from its address.
_Avoid_: slug, path id

**Route**:
An address that leads to a page.

**Slug**:
The name in a subtree address `/a/<slug>/`. A route, not an identity.

**Tree path**:
The relative HTML path of a page in a tree instance, such as `talks/intro.html`. A route, not an identity. In code: `pageRef`.

**Alias**:
An address that redirects to another address.

**Shell**:
The instance's fixed public files: landing, login and icons.

**Pinned read**:
Reading the resources of one named revision of a page. It needs a read right that holds now; a pinned-read token only makes that revision reachable for a short time.

### Access

**Visibility**:
Private, shared or public. Unknown means private.

**Team reader**:
A person whose verified identity carries the instance's read audience. Reads every page; changes nothing.
_Avoid_: team member (for someone who publishes), user

**Principal**:
A verified identity known to the management origin. First registration grants no role; signing in again never reactivates a disabled principal.

**Role**:
Publisher or administrator, held by a principal within a scope.

**Scope**:
Where a role applies: one page, or the whole installation.

**Publisher**:
May publish, change visibility and manage shares within its scope. Installation scope may also create pages.

**Administrator**:
May do everything a publisher may, assign roles and import historical shares.

**Assurance**:
What a verified identity proves on one surface: read access, management access, or nothing. In code: `surface` (`read` or `manage`).

**Share grant**:
The right a share key gives to read one shared page. Checked on every request.
_Avoid_: share link (for the right), token

**Share key**:
The secret part of a share link. Never stored in clear.

**Share cookie**:
A browser credential naming a page and its share key, set when a share link is opened. It carries no right beyond the grant it names.

**Policy epoch**:
A page's policy version. Every change of its visibility or grants, unpublishing it and restoring it increments it.

## Relationships

- An **Instance** holds many **Artefacts**; an **Artefact** has many **Revisions** and at most one **Active revision**.
- An **Artefact** contains one or more **Pages**; a **Page** belongs to exactly one **Artefact**.
- A **Page** has one **Route** and any number of **Aliases**.
- A **Revision** contains **Resources**; its **Pages** own **Fragments** and **Assets** through **Ownership**.
- A **Page** has one **Visibility** and at most one active **Share grant**.
- A **Principal** holds **Roles**, each within one **Scope**.

## Example dialogue

> **Dev:** "A team reader opened a shared page and wants to send the link. Can they rotate the key?"
> **Domain expert:** "No. A team reader reads; rotating a share is a publisher action on the management origin. Rotation ends the old share grant, so the old link and any share cookie stop working on the next request."

## Flagged ambiguities

- "Public host" meant both the canonical read host and any host serving content. Resolved: **Read origin** (canonical plus aliases) versus **Management origin**.
- "Slug" was used as the page's identity. Resolved: a slug is a **Route**; identity is the **Page ID**.
- "Team" meant both readers and publishers. Resolved: **Team reader** reads only; **Publisher** and **Administrator** are **Roles**.
