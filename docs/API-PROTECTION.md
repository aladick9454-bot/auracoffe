# AURA COFFEE — API Protection

## Purpose

Persistent API rate limiting and temporary IP blocking.

## Architecture

Express middleware uses PostgreSQL to maintain
atomic rate-limit counters and temporary IP blocks.

## Rate limits

- Admin login: 10 requests per 15 minutes.
- Public write API: 20 requests per minute.
- Public read API: 120 requests per minute.

## Automatic blocking

Five separate rate-limit violations within
10 minutes for the same public API scope
trigger a temporary 30-minute IP block.

## Manual blocking

Administrators can create temporary IP blocks
for a maximum of 24 hours.

Administrators can revoke active blocks.

## HTTP responses

- 429: Rate limit exceeded.
- 403: Temporary IP block.
- 503: Protection unavailable for protected writes.

## Database tables

- security_rate_limits
- security_ip_blocks
- security_protection_events

## Protected administrative endpoints

GET /api/protection/summary
GET /api/protection/blocks
GET /api/protection/events

POST /api/protection/blocks
POST /api/protection/blocks/:id/revoke

## Maintenance

Daily cleanup through Security Maintenance.

Counters: 2 days.
Expired blocks: 90 days.
Protection events: 90 days.

## Limitations

Client IP identification depends on trusted proxy
configuration.

Shared IP addresses may cause false positives.

Fixed windows permit bursts at window boundaries.

Public read requests fail open during database
outages.

Login and public write requests fail closed.

Internal monitoring endpoints are excluded.

This system is not a network-level firewall
or distributed denial-of-service protection.