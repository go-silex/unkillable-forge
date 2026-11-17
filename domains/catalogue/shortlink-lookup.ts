export interface ShortlinkMappingIdentity {
  mapping_id: string; provider_origin: string; short_domain: string; short_code: string
  page_id: string | null; grant_id: string | null; destination_digest: string
}
/** Internal lookup only; any mutation remains guarded by Catalogue. */
export function readShortlinkMappingIdentity(db: D1Database, mappingId: string): Promise<ShortlinkMappingIdentity | null> {
  return db.prepare('SELECT mapping_id,provider_origin,short_domain,short_code,page_id,grant_id,destination_digest FROM shortlink_mappings WHERE mapping_id=?').bind(mappingId).first<ShortlinkMappingIdentity>()
}
