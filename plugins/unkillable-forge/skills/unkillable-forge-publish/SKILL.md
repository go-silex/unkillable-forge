---
name: unkillable-forge-publish
description: Publish or resume an artifact on an explicitly configured Unkillable Forge instance using the local publisher.
---

# Publish to Unkillable Forge

1. Select the explicitly configured instance and source root requested by the operator. If the local Forge tools are unavailable, direct the operator to `unkillable-forge-setup`; do not use the legacy publisher as a fallback.
2. Discover `forge_publish` and use its advertised input schema. Supply local source references and metadata, never file bodies or credentials. For an existing artifact, use the operator's working baseline or protected checkpoint; do not silently adopt the latest revision. Declare removals explicitly.
3. Call `forge_publish`. If interrupted, use `forge_operation_status` and `forge_resume` with the returned operation ID; use `forge_abort_operation` only when requested. Retain the original baseline and operation identity on resume.
4. Report the publication receipt and separately report enrichment availability or failures. An unavailable enrichment observation does not mean publication failed. Do not reveal share keys or credentials.

A conflict or a missing selected source stops the operation. Preserve local work and ask the operator how to reconcile; absence from the local selection is not a deletion.
