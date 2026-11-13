-- Publication state is separate from Catalogue policy and immutable revision data.
CREATE TABLE publication_sessions (
  session_id TEXT PRIMARY KEY NOT NULL CHECK (length(session_id) = 29 AND substr(session_id,1,3) = 'ps_' AND substr(session_id,4) NOT GLOB '*[^a-z2-7]*'),
  instance_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  actor_authority_epoch INTEGER NOT NULL CHECK (actor_authority_epoch >= 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^!-~]*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  artifact_id TEXT NOT NULL,
  artifact_is_new INTEGER NOT NULL CHECK (artifact_is_new IN (0,1)),
  revision_id TEXT NOT NULL UNIQUE CHECK (length(revision_id) = 29 AND substr(revision_id,1,3) = 'rv_' AND substr(revision_id,4) NOT GLOB '*[^a-z2-7]*'),
  base_revision_id TEXT REFERENCES revisions(revision_id),
  base_content_version INTEGER NOT NULL CHECK (base_content_version >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  closed_at INTEGER CHECK (closed_at IS NULL OR closed_at >= created_at),
  closed_by TEXT REFERENCES principals(principal_id),
  UNIQUE(instance_id, actor_principal_id, idempotency_key)
);
CREATE INDEX publication_sessions_base ON publication_sessions(base_revision_id);
CREATE TABLE publication_files (
  session_id TEXT NOT NULL REFERENCES publication_sessions(session_id),
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document','subdocument','fragment','asset')),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK (size >= 0),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  source TEXT NOT NULL CHECK (source IN ('client','base')),
  object_key TEXT,
  stored_at INTEGER,
  CHECK ((stored_at IS NULL) = (object_key IS NULL)),
  PRIMARY KEY (session_id,path)
);
CREATE TABLE publication_pages (
  session_id TEXT NOT NULL REFERENCES publication_sessions(session_id),
  page_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('new','keep','drop','restore')),
  document_path TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR (json_valid(metadata_json) AND length(metadata_json) <= 8192)),
  expected_policy_epoch INTEGER CHECK (expected_policy_epoch IS NULL OR expected_policy_epoch >= 0),
  CHECK ((disposition = 'drop' AND document_path IS NULL AND metadata_json IS NULL) OR (disposition <> 'drop' AND document_path IS NOT NULL AND metadata_json IS NOT NULL)),
  CHECK ((disposition = 'new') = (expected_policy_epoch IS NULL)),
  PRIMARY KEY (session_id,page_id),
  UNIQUE (session_id,document_path)
);
CREATE TABLE publication_edges (
  session_id TEXT NOT NULL,
  owner_page_id TEXT NOT NULL,
  path TEXT NOT NULL,
  provider_artifact_id TEXT NOT NULL,
  PRIMARY KEY (session_id,owner_page_id,path),
  FOREIGN KEY (session_id,owner_page_id) REFERENCES publication_pages(session_id,page_id)
);
CREATE TABLE publication_events (
  event_id TEXT PRIMARY KEY NOT NULL CHECK (length(event_id) = 29 AND substr(event_id,1,3) = 'pe_' AND substr(event_id,4) NOT GLOB '*[^a-z2-7]*'),
  action TEXT NOT NULL CHECK (action IN ('seal','commit','restore','unpublish')),
  session_id TEXT REFERENCES publication_sessions(session_id),
  instance_id TEXT NOT NULL,
  idempotency_key TEXT,
  artifact_id TEXT NOT NULL,
  revision_id TEXT,
  actor_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  occurred_at INTEGER NOT NULL,
  receipt_json TEXT CHECK (receipt_json IS NULL OR (json_valid(receipt_json) AND length(receipt_json) <= 2097152)),
  verdict TEXT NOT NULL,
  CHECK ((action IN ('seal','commit')) = (session_id IS NOT NULL)),
  CHECK ((session_id IS NULL) = (idempotency_key IS NOT NULL)),
  CONSTRAINT publication_verdict_domain CHECK (verdict IN ('ok','not_found','closed','expired','incomplete','not_sealed','never_committed','conflict')),
  CONSTRAINT publication_not_found CHECK (verdict <> 'not_found'),
  CONSTRAINT publication_closed CHECK (verdict <> 'closed'),
  CONSTRAINT publication_expired CHECK (verdict <> 'expired'),
  CONSTRAINT publication_incomplete CHECK (verdict <> 'incomplete'),
  CONSTRAINT publication_not_sealed CHECK (verdict <> 'not_sealed'),
  CONSTRAINT publication_never_committed CHECK (verdict <> 'never_committed'),
  CONSTRAINT publication_conflict CHECK (verdict <> 'conflict')
);
CREATE UNIQUE INDEX publication_event_session_action ON publication_events(session_id,action) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX publication_event_idempotency ON publication_events(instance_id,actor_principal_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX publication_event_revision ON publication_events(revision_id);
CREATE TABLE publication_assertions (
  assertion_id TEXT PRIMARY KEY NOT NULL,
  verdict TEXT NOT NULL,
  CONSTRAINT publication_verdict_domain CHECK (verdict IN ('ok','not_found','closed','expired','conflict')),
  CONSTRAINT publication_not_found CHECK (verdict <> 'not_found'),
  CONSTRAINT publication_closed CHECK (verdict <> 'closed'),
  CONSTRAINT publication_expired CHECK (verdict <> 'expired'),
  CONSTRAINT publication_conflict CHECK (verdict <> 'conflict')
);
CREATE TABLE revision_discards (
  revision_id TEXT PRIMARY KEY NOT NULL REFERENCES revisions(revision_id),
  discarded_at INTEGER NOT NULL,
  purged_at INTEGER CHECK (purged_at IS NULL OR purged_at >= discarded_at),
  verdict TEXT NOT NULL,
  CONSTRAINT discard_verdict_domain CHECK (verdict IN ('ok','not_found','revision_active','revision_pinned','revision_staged','revision_retained')),
  CONSTRAINT discard_not_found CHECK (verdict <> 'not_found'),
  CONSTRAINT discard_revision_active CHECK (verdict <> 'revision_active'),
  CONSTRAINT discard_revision_pinned CHECK (verdict <> 'revision_pinned'),
  CONSTRAINT discard_revision_staged CHECK (verdict <> 'revision_staged'),
  CONSTRAINT discard_revision_retained CHECK (verdict <> 'revision_retained')
);
