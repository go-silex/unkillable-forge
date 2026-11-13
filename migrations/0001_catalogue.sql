-- Forge catalogue contract v1. docs/forge-core-contract.md §7. ADR 0002.

CREATE TABLE instance_meta (
  singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id      TEXT    NOT NULL CHECK (
                     length(instance_id) BETWEEN 2 AND 40
                     AND instance_id NOT GLOB '*[^a-z0-9-]*'
                     AND substr(instance_id, 1, 1) BETWEEN 'a' AND 'z'),
  contract_version INTEGER NOT NULL CHECK (contract_version = 1),
  created_at       INTEGER NOT NULL
);

CREATE TABLE principals (
  principal_id    TEXT PRIMARY KEY NOT NULL CHECK (length(principal_id) = 29 AND substr(principal_id, 1, 3) = 'pr_' AND substr(principal_id, 4) NOT GLOB '*[^a-z2-7]*'),
  issuer          TEXT NOT NULL CHECK (substr(issuer, 1, 8) = 'https://' AND length(issuer) <= 255),
  subject         TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
  email_hint      TEXT CHECK (email_hint IS NULL OR length(email_hint) <= 320),
  created_at      INTEGER NOT NULL,
  disabled_at     INTEGER,
  UNIQUE (issuer, subject),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

CREATE TABLE artifacts (
  artifact_id        TEXT PRIMARY KEY NOT NULL CHECK (length(artifact_id) = 29 AND substr(artifact_id, 1, 3) = 'ar_' AND substr(artifact_id, 4) NOT GLOB '*[^a-z2-7]*'),
  origin             TEXT NOT NULL CHECK (origin IN ('published', 'imported')),
  active_revision_id TEXT,
  content_version    INTEGER NOT NULL DEFAULT 0 CHECK (content_version >= 0),
  created_at         INTEGER NOT NULL,
  created_by         TEXT REFERENCES principals (principal_id),
  FOREIGN KEY (artifact_id, active_revision_id) REFERENCES revisions (artifact_id, revision_id)
);

CREATE TABLE pages (
  page_id       TEXT PRIMARY KEY NOT NULL CHECK (length(page_id) = 29 AND substr(page_id, 1, 3) = 'pg_' AND substr(page_id, 4) NOT GLOB '*[^a-z2-7]*'),
  artifact_id   TEXT NOT NULL REFERENCES artifacts (artifact_id),
  visibility    TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared', 'public')),
  policy_epoch  INTEGER NOT NULL DEFAULT 0 CHECK (policy_epoch >= 0),
  created_at    INTEGER NOT NULL,
  created_by    TEXT REFERENCES principals (principal_id),
  tombstoned_at INTEGER,
  tombstoned_by TEXT REFERENCES principals (principal_id),
  UNIQUE (page_id, artifact_id)
);
CREATE INDEX pages_by_artifact ON pages (artifact_id);

CREATE TABLE role_grants (
  role_grant_id TEXT PRIMARY KEY NOT NULL CHECK (length(role_grant_id) = 29 AND substr(role_grant_id, 1, 3) = 'rg_' AND substr(role_grant_id, 4) NOT GLOB '*[^a-z2-7]*'),
  principal_id  TEXT NOT NULL REFERENCES principals (principal_id),
  role          TEXT NOT NULL CHECK (role IN ('publisher', 'admin')),
  scope_kind    TEXT NOT NULL CHECK (scope_kind IN ('installation', 'page')),
  scope_page_id TEXT REFERENCES pages (page_id),
  origin        TEXT NOT NULL CHECK (origin IN ('bootstrap', 'granted')),
  granted_at    INTEGER NOT NULL,
  granted_by    TEXT REFERENCES principals (principal_id),
  revoked_at    INTEGER,
  revoked_by    TEXT REFERENCES principals (principal_id),
  CHECK ((scope_kind = 'page') = (scope_page_id IS NOT NULL)),
  CHECK (role = 'publisher' OR scope_kind = 'installation'),
  CHECK ((origin = 'bootstrap') = (granted_by IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX role_grants_one_active
  ON role_grants (principal_id, role, scope_kind, coalesce(scope_page_id, ''))
  WHERE revoked_at IS NULL;

CREATE TABLE revisions (
  revision_id         TEXT PRIMARY KEY NOT NULL CHECK (length(revision_id) = 29 AND substr(revision_id, 1, 3) = 'rv_' AND substr(revision_id, 4) NOT GLOB '*[^a-z2-7]*'),
  artifact_id         TEXT NOT NULL REFERENCES artifacts (artifact_id),
  origin              TEXT NOT NULL CHECK (origin IN ('published', 'imported')),
  manifest_sha256     TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_object_key TEXT NOT NULL CHECK (length(manifest_object_key) BETWEEN 1 AND 512),
  sealed_at           INTEGER NOT NULL,
  sealed_by           TEXT REFERENCES principals (principal_id),
  UNIQUE (artifact_id, revision_id)
);

CREATE TABLE revision_resources (
  revision_id  TEXT NOT NULL REFERENCES revisions (revision_id),
  path         TEXT NOT NULL CHECK (
                 length(path) BETWEEN 2 AND 1024
                 AND substr(path, 1, 1) = '/'
                 AND path NOT GLOB '*//*' AND path NOT GLOB '*/./*' AND path NOT GLOB '*/../*'
                 AND path NOT GLOB '*/.' AND path NOT GLOB '*/..' AND path NOT GLOB '*/'
                 AND path NOT GLOB '*\*'
                 AND path NOT GLOB '/s/*' AND path NOT GLOB '/_revisions/*' AND path NOT GLOB '/api/*'
                 AND path NOT GLOB '/registry/*'
                 AND path NOT IN ('/s', '/_revisions', '/api', '/manifest.json', '/asset-owners.json')),
  kind         TEXT NOT NULL CHECK (kind IN ('document', 'subdocument', 'fragment', 'asset')),
  object_key   TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 512),
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size         INTEGER NOT NULL CHECK (size >= 0),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  PRIMARY KEY (revision_id, path),
  UNIQUE (revision_id, path, kind),
  CHECK (kind IN ('fragment', 'document', 'subdocument') OR path NOT GLOB '*.html')
);

CREATE TABLE revision_pages (
  revision_id   TEXT NOT NULL REFERENCES revisions (revision_id),
  page_id       TEXT NOT NULL REFERENCES pages (page_id),
  document_path TEXT NOT NULL,
  document_kind TEXT NOT NULL DEFAULT 'document' CHECK (document_kind = 'document'),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(metadata_json) <= 8192),
  PRIMARY KEY (revision_id, page_id),
  UNIQUE (revision_id, document_path),
  FOREIGN KEY (revision_id, document_path, document_kind) REFERENCES revision_resources (revision_id, path, kind)
);

CREATE TABLE mounts (
  path        TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('document', 'subdocument', 'fragment', 'asset')),
  UNIQUE (path, artifact_id, kind),
  FOREIGN KEY (artifact_id, revision_id) REFERENCES revisions (artifact_id, revision_id),
  FOREIGN KEY (revision_id, path, kind) REFERENCES revision_resources (revision_id, path, kind)
);
CREATE INDEX mounts_by_artifact ON mounts (artifact_id);

CREATE TABLE routes (
  kind            TEXT NOT NULL CHECK (kind IN ('subtree', 'tree_page', 'redirect_exact', 'redirect_prefix')),
  route_key       TEXT NOT NULL,
  page_id         TEXT,
  artifact_id     TEXT,
  document_path   TEXT,
  document_kind   TEXT CHECK (document_kind IS NULL OR document_kind = 'document'),
  redirect_to     TEXT,
  redirect_status INTEGER CHECK (redirect_status IS NULL OR redirect_status IN (301, 302, 307, 308)),
  target_page_id  TEXT REFERENCES pages (page_id),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (kind, route_key),
  CHECK ((kind IN ('subtree', 'tree_page')) = (page_id IS NOT NULL AND artifact_id IS NOT NULL
         AND document_path IS NOT NULL AND document_kind IS NOT NULL
         AND redirect_to IS NULL AND redirect_status IS NULL AND target_page_id IS NULL)),
  CHECK ((kind IN ('redirect_exact', 'redirect_prefix')) = (redirect_to IS NOT NULL AND redirect_status IS NOT NULL
         AND page_id IS NULL AND artifact_id IS NULL AND document_path IS NULL)),
  CHECK (kind <> 'subtree' OR (
         length(route_key) BETWEEN 1 AND 200 AND route_key NOT GLOB '*[^a-z0-9-]*'
         AND route_key NOT GLOB '-*' AND route_key NOT GLOB '*-' AND route_key NOT GLOB '*--*'
         AND document_path = '/a/' || route_key || '/index.html')),
  CHECK (kind <> 'tree_page' OR (
         route_key GLOB '?*.html' AND substr(route_key, 1, 1) <> '/' AND route_key NOT GLOB '*//*'
         AND route_key NOT GLOB '*..*' AND route_key NOT GLOB '*[^A-Za-z0-9._/-]*'
         AND route_key NOT GLOB 'a/*'
         AND document_path = '/' || route_key)),
  CHECK (kind NOT IN ('redirect_exact', 'redirect_prefix') OR (
         substr(route_key, 1, 1) = '/' AND substr(redirect_to, 1, 1) = '/'
         AND substr(redirect_to, 1, 2) <> '//' AND route_key NOT GLOB '*..*')),
  CHECK (kind <> 'redirect_prefix' OR route_key GLOB '*/'),
  FOREIGN KEY (page_id, artifact_id) REFERENCES pages (page_id, artifact_id),
  FOREIGN KEY (document_path, artifact_id, document_kind) REFERENCES mounts (path, artifact_id, kind)
);
CREATE UNIQUE INDEX routes_one_primary_per_page ON routes (page_id) WHERE page_id IS NOT NULL;

CREATE TABLE resource_owners (
  owner_revision_id TEXT NOT NULL,
  owner_page_id     TEXT NOT NULL,
  path              TEXT NOT NULL CHECK (substr(path, 1, 1) = '/' AND length(path) <= 1024),
  PRIMARY KEY (owner_revision_id, owner_page_id, path),
  FOREIGN KEY (owner_revision_id, owner_page_id) REFERENCES revision_pages (revision_id, page_id)
);
CREATE INDEX resource_owners_by_path ON resource_owners (path);

CREATE TABLE share_grants (
  grant_id           TEXT PRIMARY KEY NOT NULL CHECK (length(grant_id) = 29 AND substr(grant_id, 1, 3) = 'gr_' AND substr(grant_id, 4) NOT GLOB '*[^a-z2-7]*'),
  page_id            TEXT NOT NULL REFERENCES pages (page_id),
  key_kid            TEXT NOT NULL CHECK (length(key_kid) BETWEEN 1 AND 16 AND key_kid NOT GLOB '*[^a-z0-9]*'),
  key_hmac           TEXT NOT NULL CHECK (length(key_hmac) = 64 AND key_hmac NOT GLOB '*[^0-9a-f]*'),
  mode               TEXT NOT NULL CHECK (mode IN ('follow_active', 'pinned')),
  pinned_revision_id TEXT REFERENCES revisions (revision_id),
  origin             TEXT NOT NULL CHECK (origin IN ('minted', 'imported')),
  sealed_key         TEXT CHECK (sealed_key IS NULL OR length(sealed_key) BETWEEN 16 AND 512),
  seal_kid           TEXT,
  created_at         INTEGER NOT NULL,
  created_by         TEXT REFERENCES principals (principal_id),
  revoked_at         INTEGER,
  revoked_by         TEXT REFERENCES principals (principal_id),
  revoked_reason     TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN ('revoked', 'rotated', 'visibility', 'unpublished')),
  CHECK ((mode = 'pinned') = (pinned_revision_id IS NOT NULL)),
  CHECK ((sealed_key IS NULL) = (seal_kid IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (revoked_at IS NULL OR sealed_key IS NULL)
);
CREATE UNIQUE INDEX share_grants_one_active_per_page ON share_grants (page_id) WHERE revoked_at IS NULL;
CREATE INDEX share_grants_lookup ON share_grants (page_id, key_kid, key_hmac) WHERE revoked_at IS NULL;

CREATE TABLE mutation_events (
  event_id                        TEXT PRIMARY KEY NOT NULL CHECK (length(event_id) = 29 AND substr(event_id, 1, 3) = 'ev_' AND substr(event_id, 4) NOT GLOB '*[^a-z2-7]*'),
  instance_id                     TEXT NOT NULL,
  action                          TEXT NOT NULL CHECK (action IN (
                                    'create_page', 'stage', 'publish', 'restore_page', 'unpublish', 'set_visibility', 'share',
                                    'rotate_share', 'revoke_share', 'reveal_share', 'import_share', 'set_alias',
                                    'assign_role', 'revoke_role', 'disable_principal')),
  actor_principal_id              TEXT NOT NULL,
  actor_surface                   TEXT NOT NULL,
  page_id                         TEXT,
  artifact_id                     TEXT,
  grant_id                        TEXT,
  target_principal_id             TEXT,
  role_grant_id                   TEXT,
  expected_authority_epoch        INTEGER,
  expected_policy_epoch           INTEGER,
  expected_content_version        INTEGER,
  expected_target_authority_epoch INTEGER,
  request_digest                  TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  occurred_at                     INTEGER NOT NULL,
  revision_id                     TEXT,
  verdict                         TEXT NOT NULL,
  CONSTRAINT guard_verdict_domain CHECK (verdict IN ('ok', 'instance_mismatch', 'unauthenticated', 'forbidden',
                                                     'not_found', 'conflict', 'invalid_state', 'last_admin')),
  CONSTRAINT guard_instance_mismatch CHECK (verdict <> 'instance_mismatch'),
  CONSTRAINT guard_unauthenticated   CHECK (verdict <> 'unauthenticated'),
  CONSTRAINT guard_forbidden         CHECK (verdict <> 'forbidden'),
  CONSTRAINT guard_not_found         CHECK (verdict <> 'not_found'),
  CONSTRAINT guard_conflict          CHECK (verdict <> 'conflict'),
  CONSTRAINT guard_invalid_state     CHECK (verdict <> 'invalid_state'),
  CONSTRAINT guard_last_admin        CHECK (verdict <> 'last_admin')
);
CREATE INDEX mutation_events_by_page ON mutation_events (page_id, occurred_at);
