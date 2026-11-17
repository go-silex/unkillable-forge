/** Internal post-execution state; callers must already hold Catalogue admission. */
export async function enrichmentJobState(db: D1Database, jobId: string): Promise<string | null> {
  const row = await db.prepare('SELECT state FROM enrichment_jobs WHERE job_id=?').bind(jobId).first<{state:string}>()
  return row?.state ?? null
}
