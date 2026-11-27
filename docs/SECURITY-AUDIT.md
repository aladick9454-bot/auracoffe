
# AURA COFFEE — Final Security Audit

## Purpose

Final application security review before production handover.

## Security controls

- Helmet HTTP security headers.
- Disabled X-Powered-By header.
- Restricted static file serving.
- CORS origin validation.
- Parameterized PostgreSQL queries.
- Persistent API rate limiting.
- Temporary IP blocking.
- Administrator authentication.
- Signed session cookies.
- HttpOnly, Secure and SameSite cookie attributes.
- Origin validation for administrative mutations.
- Monitoring webhook secret validation.
- Request body size limits.
- Centralized Express error handling.
- Security event monitoring.

## Automated verification

Run against a locally running test server:

    npm run test:security

Additional checks:

    npm audit --omit=dev
    npm run check
    npm test

## Known limitations

- Content Security Policy requires frontend compatibility review.
- Administrator sessions are stored in process memory.
- Proxy trust configuration depends on hosting infrastructure.
- Application rate limiting is not network-level DDoS protection.
- Frontend XSS sinks require separate review.
- Internal monitoring endpoint rate limits require further review.
- Automated tests do not replace a full penetration test.

## Secret management

- Never commit real environment files.
- Store production secrets in hosting environment variables.
- Store CI secrets in GitHub Actions secrets.
- Rotate credentials after suspected exposure.

## Release requirements

- All automated security tests pass.
- Existing project tests pass.
- No known production dependency vulnerabilities.
- Public website remains functional.
- Administrative dashboard remains functional.
- No private source files are publicly accessible.
