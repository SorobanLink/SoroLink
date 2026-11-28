# Database bootstrap and migration workflow

This guide walks through enabling PostgreSQL persistence for SoroLink from a
fresh database to a fully migrated, running backend.

## Overview

SoroLink uses two separate database connection roles:

| Env var | Role | Permissions |
|---------|------|-------------|
| `DATABASE_URL` | `sorolink_application` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on runtime tables |
| `DATABASE_MIGRATION_URL` | `sorolink_migrations` | `CREATE`, `ALTER`, `DROP`, schema-level grants |

Keeping these roles separate means the runtime credential cannot perform DDL
even if it is compromised. Migrations always run as `sorolink_migrations`.

## Step 1 — Create the database

```sql
-- Run as a superuser (e.g. postgres)
CREATE DATABASE sorolink;
\c sorolink
```

## Step 2 — Bootstrap roles

Run `bootstrap-roles.sql` as the database owner. This file is idempotent only
in the sense that it creates the four group roles; running it twice will error
on the second `CREATE ROLE`. On managed services that prohibit `CREATE ROLE`,
provision equivalent least-privilege credentials in your control plane and skip
to step 3.

```bash
psql "$ADMIN_URL" -f sorolink-backend/database/bootstrap-roles.sql
```

The script creates four group roles:

- `sorolink_application` — runtime queries
- `sorolink_worker` — background workers
- `sorolink_maintenance` — pruning and cleanup
- `sorolink_migrations` — DDL

Then grant each group role to your provider-managed login credentials:

```sql
-- Replace <login> with the actual login role names from your provider
GRANT sorolink_application TO <application_login>;
GRANT sorolink_worker      TO <worker_login>;
GRANT sorolink_maintenance TO <maintenance_login>;
GRANT sorolink_migrations  TO <migration_login>;
```

## Step 3 — Set environment variables

```dotenv
# .env (never commit this file)
DATABASE_URL=postgresql://app_login:password@host/sorolink
DATABASE_MIGRATION_URL=postgresql://migrations_login:password@host/sorolink
PERSISTENCE_MODE=published
RUN_PERSISTENCE_ENABLED=true
```

> **Note:** `PERSISTENCE_MODE=published` requires both `DATABASE_URL` and
> `DATABASE_MIGRATION_URL`. The backend will fail its readiness check and
> refuse to start if either is missing or the database is not up to date.

## Step 4 — Apply migrations

```bash
cd sorolink-backend
npm run db:migrate
```

This applies all pending migration files from `database/migrations/` in
numeric order using `DATABASE_MIGRATION_URL`. The backend verifies each
migration's SHA-256 checksum at startup; editing a migration file after it
has been applied will cause the backend to refuse to start.

Current migrations:

| File | Description |
|------|-------------|
| `001_persistence_foundation.sql` | Core tables, audit trigger, and cleanup guard |
| `002_role_privileges.sql` | Grants runtime privileges to group roles |
| `003_persistent_run_history.sql` | Extends `runs` with report fields and stable `run_id` |
| `004_optimistic_concurrency.sql` | Adds `version` column to `runs` for concurrent-write safety |

## Step 5 — Verify migration status

```bash
npm run db:migrate-status
```

This prints each migration with its applied/pending status and the stored
checksum. All migrations should show `applied`.

## Step 6 — Run reconcile

```bash
npm run db:reconcile
```

`db:reconcile` verifies that the runtime grants in `002_role_privileges.sql`
are in effect. Run it after any role change, privilege audit, or restore from
backup.

## Step 7 — Start the backend

```bash
npm run dev
```

The backend logs `persistence: published` on startup if the database is
reachable and all migrations are current.

## Rollback procedure

To reverse migration 003 (run-history fields):

```bash
psql "$DATABASE_MIGRATION_URL" -f sorolink-backend/database/migrations/003_persistent_run_history.down.sql
```

> **Warning:** The down migration deletes all run-report rows permanently.
> Take a backup before running it.

There are no down migrations for 001, 002, or 004; to roll those back,
restore from a database backup taken before those migrations were applied.

## Troubleshooting

**Backend refuses to start with "migration checksum mismatch"**
A migration file was edited after being applied. Restore the original file
from git history (`git show HEAD:sorolink-backend/database/migrations/<file>`)
and restart.

**`db:migrate` fails with "permission denied for schema public"**
The `DATABASE_MIGRATION_URL` credential is missing `sorolink_migrations`
membership. Re-run the GRANT from step 2.

**`db:reconcile` fails with "role does not exist"**
The group roles were not created. Re-run step 2 (or provision them in your
cloud control plane) and try again.
