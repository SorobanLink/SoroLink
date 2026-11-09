DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sorolink_application') THEN
    GRANT USAGE ON SCHEMA public TO sorolink_application;
    GRANT SELECT ON schema_migrations, scenarios, scenario_versions TO sorolink_application;
    GRANT SELECT, INSERT ON runs, run_steps, assertion_results, idempotency_records TO sorolink_application;
    REVOKE UPDATE, DELETE, TRUNCATE ON scenario_versions FROM sorolink_application;
    REVOKE ALL ON cleanup_audit FROM sorolink_application;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sorolink_worker') THEN
    GRANT USAGE ON SCHEMA public TO sorolink_worker;
    GRANT SELECT ON scenarios, scenario_versions TO sorolink_worker;
    GRANT SELECT, INSERT, UPDATE ON runs, run_steps TO sorolink_worker;
    GRANT SELECT, INSERT ON assertion_results TO sorolink_worker;
    REVOKE UPDATE, DELETE, TRUNCATE ON scenario_versions FROM sorolink_worker;
    REVOKE ALL ON cleanup_audit FROM sorolink_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sorolink_maintenance') THEN
    GRANT USAGE ON SCHEMA public TO sorolink_maintenance;
    GRANT SELECT, DELETE ON runs, run_steps, assertion_results, idempotency_records, scenarios, scenario_versions TO sorolink_maintenance;
    GRANT SELECT, INSERT ON cleanup_audit TO sorolink_maintenance;
    GRANT USAGE, SELECT ON SEQUENCE cleanup_audit_id_seq TO sorolink_maintenance;
    GRANT EXECUTE ON FUNCTION reject_scenario_version_mutation() TO sorolink_maintenance;
    GRANT EXECUTE ON FUNCTION guard_run_cleanup(), guard_scenario_cleanup() TO sorolink_maintenance;
    REVOKE UPDATE, TRUNCATE ON scenario_versions FROM sorolink_maintenance;
  END IF;
END $$;
