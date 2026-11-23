-- Early access runs on the shared request database (T-574). Grants only; no table, column or row changes (D73).
REVOKE ALL ON early_access_request, early_access_attempt FROM everyfield_runtime, everyfield_auth, everyfield_cleanup;
GRANT SELECT, INSERT, DELETE ON early_access_request TO everyfield_runtime;
GRANT UPDATE (ip_address, mail_id, mailed_at) ON early_access_request TO everyfield_runtime;
GRANT SELECT, INSERT, DELETE ON early_access_attempt TO everyfield_runtime;
