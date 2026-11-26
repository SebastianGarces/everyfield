-- An effective location row never changes (SCHEMA-001). The runtime corrects a church's location by appending a row
-- that supersedes the old one, so it keeps only SELECT and INSERT. The church purge deletes rows inside the
-- SECURITY DEFINER settings_purge_content, so cleanup keeps SELECT and DELETE and needs no UPDATE.
REVOKE UPDATE, DELETE ON "plant_geography" FROM everyfield_runtime;
--> statement-breakpoint
REVOKE UPDATE ON "plant_geography" FROM everyfield_cleanup;
