-- Run once as the database owner. Managed services that prohibit CREATE ROLE
-- should provision equivalent least-privilege credentials in their control plane.
CREATE ROLE sorolink_application NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE sorolink_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE sorolink_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE sorolink_migrations NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

GRANT USAGE, CREATE ON SCHEMA public TO sorolink_migrations;

-- Grant exactly one group role to each provider-managed LOGIN credential:
-- GRANT sorolink_application TO <application_login>;
-- GRANT sorolink_worker TO <worker_login>;
-- GRANT sorolink_maintenance TO <maintenance_login>;
-- GRANT sorolink_migrations TO <migration_login>;
