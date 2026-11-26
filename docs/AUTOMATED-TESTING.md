# AURA COFFEE — Automated Testing

## Purpose

Automatic validation of application code,
API protection and PostgreSQL functionality.

## Local commands

npm run check
npm test
npm run ci
npm run test:db
npm run test:smoke

## Testing levels

- Project structure validation.
- JavaScript syntax validation.
- Unit tests.
- Express integration tests.
- PostgreSQL integration tests.
- Production smoke tests.

## GitHub Actions

CI Pipeline runs on:

- Push to main.
- Pull request to main.
- Manual dispatch.

Database tests run only on trusted main branch runs.

Production Smoke Tests run every six hours
and can be started manually.

## Required secrets

- CI_TEST_DATABASE_URL
- CI_MONITOR_SECRET
- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID

CI_TEST_DATABASE_URL must reference a separate
test database branch, never production.

## Monitoring endpoints

POST /api/ci/ingest
GET /api/ci/summary
GET /api/ci/runs

## Storage

monitoring_ci_runs

History retention: 90 days.

## Deployment

Render deployment should wait for successful
CI checks where supported.

## Limitations

Tests cover selected application behavior,
not every possible application defect.

Database schema changes must also be applied
to the test database branch.

Production smoke tests are separate from
pre-deployment tests.

GitHub Actions schedules are best effort.

CI report delivery can fail independently
of the actual test result.