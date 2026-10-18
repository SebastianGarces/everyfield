-- Reviewed runtime and witnessed-cleanup capabilities for onboarding storage.
-- Original receipts are append-only for the ordinary application writer.
GRANT SELECT,INSERT,UPDATE ON onboarding_setup TO everyfield_runtime;
GRANT SELECT,INSERT ON onboarding_result TO everyfield_runtime;
GRANT SELECT,UPDATE,DELETE ON onboarding_setup,onboarding_result TO everyfield_cleanup;
