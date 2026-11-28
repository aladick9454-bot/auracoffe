
# AURA COFFEE — Production Rollback

## 1. Purpose

Restore a previously working application
deployment after a failed production release.

## 2. Rollback triggers

- Production application is unavailable.
- Health or readiness checks fail.
- Critical booking functionality fails.
- Administrative authentication fails.
- Critical automation integration fails.
- A serious security regression is detected.

## 3. Preparation

Before each release:

- Record the current production commit.
- Identify the previous successful deployment.
- Verify recent backup availability.
- Review database compatibility.
- Review environment configuration.
- Review automation compatibility.

## 4. Application rollback

1. Open the Render service dashboard.
2. Locate the deployment history.
3. Identify the previous known-good deployment.
4. Review database and configuration compatibility.
5. Use the supported rollback or redeployment option.
6. Wait for deployment completion.
7. Verify application health and readiness.
8. Verify public website functionality.
9. Verify administrative access.
10. Review monitoring and application logs.

## 5. Database safety

Application rollback does not automatically
restore the previous database state.

Do not restore or downgrade the production
database without an approved recovery plan.

Database restoration may cause data loss.

## 6. Git safety

Do not rewrite the shared main branch.

Do not force-push release tags.

Use a reviewed revert or corrective commit
to restore the repository to a working state.

## 7. Post-rollback verification

- Homepage returns HTTP 200.
- Health endpoint returns HTTP 200.
- Readiness endpoint returns HTTP 200.
- Critical business functionality is verified.
- Monitoring reports normal operation.

## 8. Incident documentation

Record:

- Failed release version.
- Previous working deployment.
- Incident start time.
- Business impact.
- Rollback completion time.
- Root cause.
- Corrective actions.

## 9. Limitations

Application rollback does not automatically
restore database contents, n8n workflows,
external integrations or environment variables.

Full production recovery must be coordinated
using the disaster recovery documentation.
