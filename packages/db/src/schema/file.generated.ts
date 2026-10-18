// Generated from docs/schema/target.json by generate.py.
export interface FileObjectRow {
  id: string;
  tenant_id: string;
  purpose: "avatar" | "person_photo" | "commitment" | "generated" | "native_import" | "assistant_staging" | "communication_attachment";
  opaque_key: string;
  media_type: string;
  max_bytes: string;
  byte_count: string | null;
  sha256: string | null;
  state: "pending" | "ready" | "failed" | "cleanup" | "purged";
  upload_key: string;
  expires_at: Date | null;
  claim_generation: string;
  retention_until: Date | null;
  purge_requested_at: Date | null;
  purged_at: Date | null;
  revision: string;
}
