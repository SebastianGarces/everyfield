GRANT SELECT, INSERT, DELETE ON early_access_request TO everyfield_runtime;
GRANT UPDATE (ip_address, mail_id, mailed_at) ON early_access_request TO everyfield_runtime;
GRANT SELECT, INSERT, DELETE ON early_access_attempt TO everyfield_runtime;
