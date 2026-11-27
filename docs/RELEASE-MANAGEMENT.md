# AURA COFFEE — Release Management

## Purpose

Controlled production deployment with automated
validation, migration checks, deployment monitoring,
smoke tests and application rollback.

## Deployment strategy

Continuous Delivery with explicit manual approval.

Render Auto-Deploy must remain disabled.

Production deployments require the main branch.

## Release workflow

1. Validate version and confirmation.
2. Run project validation.
3. Run automated tests.
4. Apply migrations to the test database.
5. Run PostgreSQL integration tests.
6. Verify recent backup and restore test records.
7. Apply production migrations.
8. Verify migration integrity.
9. Compare database schemas.
10. Deploy exact Git commit through Render API.
11. Wait for live deployment.
12. Verify deployed commit.
13. Run health and readiness checks.
14. Run production smoke tests.
15. Record release result.
16. Notify administrators.

## GitHub secrets

RENDER_API_KEY

RENDER_SERVICE_ID

PRODUCTION_DATABASE_URL

CI_TEST_DATABASE_URL

TELEGRAM_BOT_TOKEN

TELEGRAM_CHAT_ID

Production credentials must be stored in a
protected GitHub Environment where possible.

## Manual release confirmation

RELEASE_PRODUCTION

## Version format

1.0.0
1.0.1
1.1.0
2.0.0

## Backup safety requirements

Successful backup: no older than 24 hours.

Successful restore test: no older than 48 hours.

Database records are used to verify backup freshness.
This does not independently verify backup file contents
or prove that the latest backup was restored.

## Rollback

Application rollback restores the previous
Render deployment when appropriate.

Database migrations are not automatically reversed.

Production migrations must remain compatible
with the previous application version.

If deployment state is unknown, investigate
Render before issuing another deployment.

## Release statuses

pending
deploying
verifying
success
failed
rolling_back
rolled_back
rollback_failed

An unfinished release requires manual investigation.

## Monitoring

GET /api/releases/summary

GET /api/releases/history

GET /api/releases/:id/events

All endpoints require administrator authentication.

## Database objects

application_releases

application_release_events

application_release_summary

## Operational rules

Never deploy while another release is active.

Never expose production credentials.

Never edit applied SQL migrations.

Never use destructive schema changes without
a separately reviewed migration and recovery plan.

Never assume a rollback succeeded without
health checks and operational verification.

## Known limitations

Workflow cancellation can interrupt deployment polling.

GitHub Actions cannot guarantee automatic rollback
when the network or database is unavailable.

Render deployment rollback does not roll back
the separately hosted GitHub Pages frontend.

Release history does not include failures that
occur before a release record is created.