import "server-only";

// Operator receipts and actual customer-data gates remain with WP-050/058.
// This producer must never turn vendor names or user claims into permission.
export function platformReadiness() {
  return { customer_data_allowed: false, recovery_proven: false, disaster_sla: null, provider_setup_authorized: false,
    new_paid_commitment_allowed: false, unlimited_free_usage_claimed: false,
    settings_verified: false, credits_verified: false, AI_processing_allowed: false, release_gate: "blocked",
    requiredEvidence: ["separate_private_backup_bucket_and_keys", "seven_day_history_and_expiry", "encrypted_daily_copy", "coherent_database_and_matching_bytes_restore", "measured_1h_rpo_4h_rto", "current_deletion_witnesses", "approved_customer_ai_path"] };
}
