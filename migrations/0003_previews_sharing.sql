-- Refuse conflicting existing originals and staged paths before introducing the reserved namespace.
CREATE TABLE preview_namespace_assertion (verdict TEXT NOT NULL CONSTRAINT preview_namespace_collision CHECK (verdict = 'ok'));
INSERT INTO preview_namespace_assertion (verdict)
SELECT CASE WHEN EXISTS (SELECT 1 FROM revision_resources WHERE path = '/_derived' OR path GLOB '/_derived/*')
 OR EXISTS (SELECT 1 FROM publication_files WHERE path = '/_derived' OR path GLOB '/_derived/*')
 OR EXISTS (SELECT 1 FROM publication_edges WHERE path = '/_derived' OR path GLOB '/_derived/*')
 OR EXISTS (SELECT 1 FROM publication_pages WHERE document_path = '/_derived' OR document_path GLOB '/_derived/*')
 THEN 'collision' ELSE 'ok' END;
DROP TABLE preview_namespace_assertion;
ALTER TABLE revision_resources ADD COLUMN preview_path_guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT revision_resource_preview_path CHECK (path <> '/_derived' AND path NOT GLOB '/_derived/*');
ALTER TABLE publication_files ADD COLUMN preview_path_guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT publication_file_preview_path CHECK (path <> '/_derived' AND path NOT GLOB '/_derived/*');
ALTER TABLE publication_edges ADD COLUMN preview_path_guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT publication_edge_preview_path CHECK (path <> '/_derived' AND path NOT GLOB '/_derived/*');
ALTER TABLE publication_pages ADD COLUMN preview_path_guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT publication_page_preview_path CHECK (document_path IS NULL OR (document_path <> '/_derived' AND document_path NOT GLOB '/_derived/*'));


-- Rebuild the event table without changing the contract version or refusal domains.
CREATE TABLE mutation_events_f09 (
  event_id TEXT PRIMARY KEY NOT NULL CHECK (length(event_id) = 29 AND substr(event_id,1,3) = 'ev_' AND substr(event_id,4) NOT GLOB '*[^a-z2-7]*'),
  instance_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create_page','stage','publish','restore_page','unpublish','set_visibility','share','rotate_share','revoke_share','reveal_share','import_share','set_alias','assign_role','revoke_role','disable_principal','enrich_page','set_shortlink')),
  actor_principal_id TEXT NOT NULL, actor_surface TEXT NOT NULL, page_id TEXT, artifact_id TEXT,
  grant_id TEXT, target_principal_id TEXT, role_grant_id TEXT, expected_authority_epoch INTEGER,
  expected_policy_epoch INTEGER, expected_content_version INTEGER, expected_target_authority_epoch INTEGER,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  occurred_at INTEGER NOT NULL, revision_id TEXT, verdict TEXT NOT NULL,
  CONSTRAINT guard_verdict_domain CHECK (verdict IN ('ok','instance_mismatch','unauthenticated','forbidden','not_found','conflict','invalid_state','last_admin')),
  CONSTRAINT guard_instance_mismatch CHECK (verdict <> 'instance_mismatch'),
  CONSTRAINT guard_unauthenticated CHECK (verdict <> 'unauthenticated'),
  CONSTRAINT guard_forbidden CHECK (verdict <> 'forbidden'),
  CONSTRAINT guard_not_found CHECK (verdict <> 'not_found'),
  CONSTRAINT guard_conflict CHECK (verdict <> 'conflict'),
  CONSTRAINT guard_invalid_state CHECK (verdict <> 'invalid_state'),
  CONSTRAINT guard_last_admin CHECK (verdict <> 'last_admin')
);
INSERT INTO mutation_events_f09 SELECT * FROM mutation_events;
DROP TABLE mutation_events;
ALTER TABLE mutation_events_f09 RENAME TO mutation_events;
CREATE INDEX mutation_events_by_page ON mutation_events (page_id, occurred_at);

CREATE TABLE preview_objects (
  page_id TEXT NOT NULL, revision_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
  recipe_sha256 TEXT NOT NULL CHECK(length(recipe_sha256)=64 AND recipe_sha256 NOT GLOB '*[^0-9a-f]*'),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  extension TEXT NOT NULL CHECK(extension IN ('jpg','png')),
  size INTEGER NOT NULL CHECK(size >= 0), object_version TEXT NOT NULL CHECK(length(object_version)>0),
  PRIMARY KEY(page_id,revision_id,recipe_sha256,input_sha256,content_sha256,extension),
  FOREIGN KEY(revision_id,page_id) REFERENCES revision_pages(revision_id,page_id),
  FOREIGN KEY(artifact_id,revision_id) REFERENCES revisions(artifact_id,revision_id)
);
CREATE TABLE preview_selections (
  page_id TEXT NOT NULL, revision_id TEXT NOT NULL,
  original_path TEXT,
  recipe_sha256 TEXT, input_sha256 TEXT, content_sha256 TEXT, extension TEXT,
  CHECK ((original_path IS NOT NULL AND recipe_sha256 IS NULL AND input_sha256 IS NULL AND content_sha256 IS NULL AND extension IS NULL)
      OR (original_path IS NULL AND recipe_sha256 IS NOT NULL AND input_sha256 IS NOT NULL AND content_sha256 IS NOT NULL AND extension IS NOT NULL)),
  PRIMARY KEY(page_id,revision_id),
  FOREIGN KEY(revision_id,page_id) REFERENCES revision_pages(revision_id,page_id),
  FOREIGN KEY(revision_id,original_path) REFERENCES revision_resources(revision_id,path),
  FOREIGN KEY(page_id,revision_id,recipe_sha256,input_sha256,content_sha256,extension) REFERENCES preview_objects(page_id,revision_id,recipe_sha256,input_sha256,content_sha256,extension)
);
CREATE TABLE shortlink_mappings (
  mapping_id TEXT PRIMARY KEY NOT NULL, provider_origin TEXT NOT NULL, provider_id TEXT,
  short_domain TEXT NOT NULL CHECK(length(short_domain)>0), short_code TEXT NOT NULL, short_url TEXT NOT NULL, page_id TEXT REFERENCES pages(page_id),
  grant_id TEXT REFERENCES share_grants(grant_id), destination TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('imported','created')), observed_at INTEGER NOT NULL,
  destination_digest TEXT NOT NULL CHECK(length(destination_digest)=64 AND destination_digest NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(provider_origin,short_domain,short_code)
);

CREATE TABLE enrichment_jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL, revision_id TEXT NOT NULL, page_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('og','shortlink')),
  input_sha256 TEXT CHECK(input_sha256 IS NULL OR (length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^0-9a-f]*')),
  recipe_sha256 TEXT CHECK(recipe_sha256 IS NULL OR (length(recipe_sha256)=64 AND recipe_sha256 NOT GLOB '*[^0-9a-f]*')),
  desired_grant_id TEXT REFERENCES share_grants(grant_id),
  desired_mapping_id TEXT, provider_origin TEXT, requested_short_domain TEXT, requested_short_code TEXT, destination_sha256 TEXT,
  expected_content_version INTEGER NOT NULL CHECK(expected_content_version >= 0),
  expected_policy_epoch INTEGER NOT NULL CHECK(expected_policy_epoch >= 0),
  state TEXT NOT NULL CHECK(state IN ('pending','running','ready','failed','superseded')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  lease_token TEXT, lease_expires_at INTEGER,
  error_code TEXT CHECK(error_code IS NULL OR error_code IN ('render_timeout','render_rejected','render_unavailable','integrity_error','shortlink_unavailable','shortlink_conflict','target_changed')),
  retryable INTEGER CHECK(retryable IS NULL OR retryable IN (0,1)),
  result_source TEXT CHECK(result_source IS NULL OR result_source IN ('preserved','generated','created')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  CHECK ((kind='og' AND ((input_sha256 IS NULL AND recipe_sha256 IS NULL AND attempt=0 AND state IN ('pending','superseded')) OR (input_sha256 IS NOT NULL AND recipe_sha256 IS NOT NULL)) AND desired_mapping_id IS NULL AND provider_origin IS NULL AND requested_short_domain IS NULL AND requested_short_code IS NULL AND destination_sha256 IS NULL)
      OR (kind='shortlink' AND input_sha256 IS NOT NULL AND recipe_sha256 IS NULL AND desired_mapping_id IS NOT NULL AND length(desired_mapping_id)>0 AND provider_origin IS NOT NULL AND length(provider_origin)>0 AND requested_short_domain IS NOT NULL AND length(requested_short_domain)>0 AND requested_short_code IS NOT NULL AND length(requested_short_code)>0 AND destination_sha256 IS NOT NULL AND length(destination_sha256)=64 AND destination_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK ((state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK ((state = 'failed' AND error_code IS NOT NULL AND retryable IS NOT NULL) OR (state <> 'failed' AND error_code IS NULL AND retryable IS NULL)),
  CHECK ((state = 'ready' AND result_source IS NOT NULL) OR (state <> 'ready' AND result_source IS NULL)),
  FOREIGN KEY(revision_id,page_id) REFERENCES revision_pages(revision_id,page_id),
  FOREIGN KEY(artifact_id,revision_id) REFERENCES revisions(artifact_id,revision_id)
);
CREATE UNIQUE INDEX enrichment_job_identity ON enrichment_jobs(page_id,revision_id,kind,input_sha256,coalesce(desired_grant_id,''));
CREATE UNIQUE INDEX enrichment_og_intent_identity ON enrichment_jobs(page_id,revision_id,expected_content_version,expected_policy_epoch,coalesce(desired_grant_id,'')) WHERE kind='og' AND input_sha256 IS NULL;
CREATE INDEX enrichment_jobs_claim ON enrichment_jobs(state,lease_expires_at,updated_at,job_id);
CREATE TABLE enrichment_graph_chunks (
  job_id TEXT NOT NULL REFERENCES enrichment_jobs(job_id),
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 65536),
  PRIMARY KEY(job_id,chunk_index)
);
CREATE TABLE enrichment_attempts (
  job_id TEXT NOT NULL REFERENCES enrichment_jobs(job_id), attempt INTEGER NOT NULL CHECK(attempt > 0),
  lease_token TEXT NOT NULL, started_at INTEGER NOT NULL, lease_expires_at INTEGER NOT NULL CHECK(lease_expires_at > started_at),
  completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= started_at),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('ready','failed','superseded','expired')),
  error_code TEXT CHECK(error_code IS NULL OR error_code IN ('render_timeout','render_rejected','render_unavailable','integrity_error','shortlink_unavailable','shortlink_conflict','target_changed')),
  PRIMARY KEY(job_id,attempt), UNIQUE(job_id,lease_token),
  CHECK((completed_at IS NULL) = (outcome IS NULL))
);
CREATE TABLE enrichment_assertions (
  assertion_id TEXT PRIMARY KEY NOT NULL,
  verdict TEXT NOT NULL CONSTRAINT enrichment_assertion CHECK (verdict = 'ok')
);
