# AURA COFFEE — Database Migrations

## Purpose

Version-controlled PostgreSQL schema management.

## Database environments

- production: live application database.
- ci-testing: isolated integration test database.

## Baseline

database/baseline.sql contains the initial public
schema exported before migration version 0001.

The baseline must not be applied to an existing
production database.

Review the baseline before committing it.

## Migration naming

0001_migration_metadata.sql
0002_database_metadata.sql
0003_example_change.sql

Migration versions must be unique and increasing.

## Commands

npm run db:status
npm run db:migrate
npm run db:verify
npm run db:schema
npm run test:migrations

## Environment variables

MIGRATION_TARGET
CI_TEST_DATABASE_URL
PRODUCTION_DATABASE_URL
MIGRATION_CONFIRM

Never commit database credentials.

Use direct PostgreSQL connections for migrations.

## Production confirmation

MIGRATION_TARGET=production

MIGRATION_CONFIRM=APPLY_PRODUCTION

## Migration rules

1. Never edit an already applied migration.
2. Never delete migration history.
3. Create a new migration for each schema change.
4. Test migrations on ci-testing first.
5. Create and verify a backup before production changes.
6. Review destructive or long-running SQL carefully.
7. Do not use explicit transaction commands in migrations.
8. Keep schema changes compatible with the live application.
9. Do not expose migration execution through public APIs.

## Transaction behavior

Each migration is applied in a separate transaction.

A failed migration is rolled back.

Previously committed migrations remain applied.

Advisory locks prevent simultaneous execution
by cooperating migration processes.

## Integrity

SHA-256 checksums detect changes to applied files.

Migration verification checks history and pending files.

Schema comparison checks selected database objects.

Neither check proves that all database properties
or application behavior are correct.

## GitHub Actions

CI Pipeline automatically migrates the test database.

Database Migrations workflow applies production
migrations after explicit manual confirmation.

Production environment approval is recommended
where available.

## Monitoring API

GET /api/migrations/summary

GET /api/migrations/history

Both endpoints require administrator authentication.

## Backup

schema_migrations and database_metadata must
be included in PostgreSQL backups and restore tests.

Migration history has no automatic retention limit.