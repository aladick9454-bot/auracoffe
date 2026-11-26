# AURA COFFEE — Disaster Recovery Plan

## 1. Purpose

This document describes backup and disaster
recovery procedures for AURA COFFEE.

## 2. Protected Components

- Neon PostgreSQL database
- n8n workflow definitions
- Application source code in GitHub

## 3. Backup Policy

- Frequency: daily
- Scheduled time: 03:00 local Windows time
- Retention period: 30 days
- Database format: PostgreSQL custom dump
- Workflow format: JSON
- Integrity verification: SHA-256

## 4. Recovery Objectives

- Target RPO: 24 hours
- Target RTO: 60 minutes

These are target objectives, not guaranteed SLAs.

## 5. Backup Location

Local user directory:

AURA-Backups

Backup contents:

- database.dump
- workflows.json
- manifest.json
- restore-report.json (after a successful restore test)

## 6. Manual Backup

Run scripts/backup.ps1 from the project directory.

Docker and the n8n container must be running.

## 7. Restore Testing

Run scripts/restore-test.ps1.

The script creates an isolated PostgreSQL container,
verifies backup integrity, restores the database
and checks required monitoring tables.

The production database is not modified.

## 8. Disaster Recovery Procedure

1. Identify the affected components.
2. Stop affected automation workflows.
3. Prevent further writes to damaged systems.
4. Select a valid backup.
5. Verify SHA-256 checksums.
6. Restore the database in an isolated environment.
7. Validate database tables and business data.
8. Import required n8n workflows.
9. Configure credentials and environment variables.
10. Switch the application to the recovered database.
11. Verify API, CRM and monitoring functionality.
12. Resume automation workflows.
13. Document the incident and recovery results.

## 9. Notifications

Workflow:

AURA COFFEE — Backup Status Monitor

Backup results are sent to Telegram through an
authenticated local n8n webhook.

## 10. Security

- Never commit backup archives to GitHub.
- Never publish backup.env.
- Restrict access to database backups.
- Protect database credentials.
- Use encrypted storage for production backups.

## 11. Current Limitations

- Backups depend on the local Windows computer.
- Docker must be available.
- The scheduled task requires a user session.
- Google Sheets CRM backup is not included.
- n8n credentials are not included.
- n8n execution history is not included.
- Render environment variables are not included.
- Offsite encrypted storage is not configured.
- Missing-backup detection is not implemented.
- Telegram delivery is not guaranteed.
- Full production recovery has not been verified.

## 12. Maintenance

Review backup history regularly.

Perform restore tests periodically.

Update this document whenever the infrastructure
or recovery procedures change.

## 13. Backup Reliability Monitoring

Backup execution results are synchronized
with Neon PostgreSQL through n8n and
authenticated Express API endpoints.

Monitoring tables:

- monitoring_backup_runs
- monitoring_restore_tests
- monitoring_backup_alert_state

Backup health thresholds:

- Healthy: successful backup younger than 26 hours
- Warning: backup age from 26 to 48 hours,
  or latest backup attempt failed
- Critical: backup age of 48 hours or more
- Unknown: no successful backup registered

Target RPO remains 24 hours.

Restore tests should be performed every 30 days.

The administration dashboard refreshes every
60 seconds while the page is visible.

Backup Watchdog checks backup health every
15 minutes and sends Telegram notifications
when the backup status changes.

Unresolved problems trigger reminders
approximately every 24 hours.

Current limitations:

- Watchdog notifications depend on n8n availability.
- Local computer shutdown can prevent notifications.
- Backup synchronization does not have a durable
  retry queue.
- Historical backups created before monitoring
  integration are not included in the statistics.
- Restore tests are started manually.
- Full production disaster recovery is not verified.