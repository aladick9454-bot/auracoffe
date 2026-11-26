# AURA COFFEE - Independent Cloud Monitoring

## Overview

Independent monitoring is executed through
GitHub-hosted Actions runners.

The cloud watchdog does not require
the local computer or Docker to be running.

## Components

- Website availability
- Backend health
- PostgreSQL readiness
- Local n8n heartbeat
- Central monitoring freshness
- Backup system health
- Cloud watchdog freshness

## Heartbeat

The local n8n instance sends a heartbeat
every 5 minutes.

The backend records the server-side
receipt timestamp.

Heartbeat thresholds:

- Healthy: age up to 15 minutes
- Warning: age above 15 minutes
- Critical: age above 30 minutes
- Unknown: no heartbeat registered

## Cloud Schedule

GitHub Actions cron:

7,22,37,52 * * * *

Scheduled checks may be delayed.

Manual execution is supported.

## Cloud Freshness

- Healthy: age up to 45 minutes
- Warning: age above 45 minutes
- Critical: age above 90 minutes

## Security

The heartbeat and cloud APIs use
independent authentication secrets.

Secrets are stored in:

- Render environment variables
- n8n encrypted credentials
- GitHub Actions repository secrets

The administration API requires
an authenticated administrator session.

## Database

- monitoring_heartbeats
- monitoring_cloud_checks
- monitoring_cloud_alert_state
- monitoring_cloud_notifications

Cloud check history is retained
for 90 days.

## Notifications

Telegram alerts are sent when the
component status signature changes.

Unresolved problems generate reminders
approximately once every 24 hours.

Alerts are recorded only after
successful Telegram delivery.

## Fallback Mode

When the backend or database is
unavailable, the cloud runner attempts
direct Telegram delivery.

Fallback messages may be repeated.

## Limitations

GitHub Actions schedules are best effort.

Local n8n inactivity does not identify
the exact cause of the outage.

An additional external dead-man switch
is required to detect failures of
GitHub Actions itself when the admin
dashboard is not open.

Exactly-once Telegram delivery
is not guaranteed.

The system is an educational
production-oriented implementation,
not a guaranteed monitoring SLA.