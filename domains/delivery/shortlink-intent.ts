export interface ShortlinkIntent {
  artifact_id: string; revision_id: string; page_id: string; input_sha256: string
  desired_grant_id: string | null; desired_mapping_id: string; provider_origin: string
  requested_short_domain: string; requested_short_code: string; destination_sha256: string
  expected_content_version: number; expected_policy_epoch: number
}
/** Internal read only; external effects require fresh Catalogue and lease admission. */
export function readShortlinkIntent(db: D1Database, jobId: string): Promise<ShortlinkIntent | null> {
  return db.prepare("SELECT artifact_id,revision_id,page_id,input_sha256,desired_grant_id,desired_mapping_id,provider_origin,requested_short_domain,requested_short_code,destination_sha256,expected_content_version,expected_policy_epoch FROM enrichment_jobs WHERE job_id=? AND kind='shortlink'").bind(jobId).first<ShortlinkIntent>()
}
