-- Preserve all existing audit verdicts while adding the administrator-only import action.
CREATE TABLE mutation_events_f10 (
  event_id TEXT PRIMARY KEY NOT NULL CHECK (length(event_id) = 29 AND substr(event_id,1,3) = 'ev_' AND substr(event_id,4) NOT GLOB '*[^a-z2-7]*'),
  instance_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create_page','stage','publish','restore_page','unpublish','set_visibility','share','rotate_share','revoke_share','reveal_share','import_share','set_alias','assign_role','revoke_role','disable_principal','enrich_page','set_shortlink','import_state')),
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
INSERT INTO mutation_events_f10 SELECT * FROM mutation_events;
DROP TABLE mutation_events;
ALTER TABLE mutation_events_f10 RENAME TO mutation_events;
CREATE INDEX mutation_events_by_page ON mutation_events (page_id, occurred_at);

ALTER TABLE publication_sessions ADD COLUMN import_plan_id TEXT;
ALTER TABLE publication_sessions ADD COLUMN import_plan_digest TEXT;
CREATE UNIQUE INDEX publication_session_import_plan ON publication_sessions(instance_id,import_plan_id) WHERE import_plan_id IS NOT NULL;
CREATE TRIGGER publication_import_binding_insert BEFORE INSERT ON publication_sessions
WHEN (NEW.import_plan_id IS NULL) <> (NEW.import_plan_digest IS NULL)
BEGIN SELECT RAISE(ABORT, 'invalid import binding'); END;
CREATE TRIGGER publication_import_binding_update BEFORE UPDATE ON publication_sessions
WHEN NEW.import_plan_id IS NOT OLD.import_plan_id OR NEW.import_plan_digest IS NOT OLD.import_plan_digest
BEGIN SELECT RAISE(ABORT, 'immutable import binding'); END;

CREATE TABLE publication_imports (
  instance_id TEXT NOT NULL, plan_id TEXT NOT NULL, plan_digest TEXT NOT NULL,
  inventory_id TEXT NOT NULL, selection_id TEXT NOT NULL, source_instance TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL, source_digest TEXT NOT NULL, approval_ref TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES publication_sessions(session_id), artifact_id TEXT NOT NULL,
  revision_id TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  PRIMARY KEY(instance_id,plan_id)
);
CREATE INDEX publication_import_source ON publication_imports(instance_id,source_instance,source_artifact_id);
CREATE TRIGGER publication_import_source_mapping BEFORE INSERT ON publication_imports
WHEN EXISTS (SELECT 1 FROM publication_imports WHERE instance_id=NEW.instance_id AND source_instance=NEW.source_instance AND source_artifact_id=NEW.source_artifact_id AND artifact_id<>NEW.artifact_id)
BEGIN SELECT RAISE(ABORT, 'conflicting source mapping'); END;
CREATE TABLE catalogue_import_operations (
  instance_id TEXT NOT NULL, plan_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('page_policy','alias','shortlink','preview_selection')),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  PRIMARY KEY(instance_id,plan_id,operation_id),
  FOREIGN KEY(instance_id,plan_id) REFERENCES publication_imports(instance_id,plan_id)
);
CREATE TABLE import_assertions (
  assertion_id TEXT PRIMARY KEY NOT NULL,
  verdict TEXT NOT NULL CONSTRAINT import_assertion CHECK (verdict = 'ok')
);
CREATE TRIGGER import_assertions_transient AFTER INSERT ON import_assertions
BEGIN DELETE FROM import_assertions WHERE assertion_id=NEW.assertion_id; END;
