
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const BASE_URL =
    process.env.SECURITY_TEST_BASE_URL ||
    "http://127.0.0.1:3001";

async function request(path, options = {}) {
    return fetch(`${BASE_URL}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        ...options
    });
}

// 1. Доступность сервера

test("Health endpoint is available", async () => {
    const response = await request("/health");

    assert.equal(response.status, 200);
});

// 2. Защитные HTTP-заголовки

test("X-Powered-By is disabled", async () => {
    const response = await request("/health");

    assert.equal(
        response.headers.get("x-powered-by"),
        null
    );
});

test("MIME sniffing protection is enabled", async () => {
    const response = await request("/health");

    assert.equal(
        response.headers.get("x-content-type-options"),
        "nosniff"
    );
});

test("Clickjacking protection is enabled", async () => {
    const response = await request("/health");

    assert.ok(
        ["DENY", "SAMEORIGIN"].includes(
            response.headers.get("x-frame-options")
        )
    );
});

test("Referrer policy is enabled", async () => {
    const response = await request("/health");

    assert.ok(
        response.headers.get("referrer-policy")
    );
});

// 3. Внутренние файлы недоступны

const protectedFiles = [
    "/server.js",
    "/package.json",
    "/package-lock.json",
    "/.env",
    "/.git/config",
    "/services/api-protection.js",
    "/services/security-monitoring.js",
    "/scripts/backup.ps1",
    "/docs/API-PROTECTION.md",
    "/tests/api-protection.test.cjs",
    "/admin-monitoring.html",
    "/frontend/monitoring.js",
    "/frontend/monitoring.css"
];

for (const path of protectedFiles) {
    test(`Private file is protected: ${path}`, async () => {
        const response = await request(path);

        assert.equal(response.status, 404);
    });
}

// 4. Публичный сайт доступен

test("Public homepage remains available", async () => {
    const response = await request("/");

    assert.equal(response.status, 200);
});

// 5. Административные маршруты защищены

const protectedEndpoints = [
    "/api/monitoring/admin",
    "/api/monitoring/analytics",
    "/api/monitoring/incidents",
    "/api/monitoring/recovery",
    "/api/security/summary",
    "/api/security/events",
    "/api/protection/summary",
    "/api/protection/blocks",
    "/admin/monitoring.js",
    "/admin/monitoring.css"
];

for (const path of protectedEndpoints) {
    test(`Authentication required: ${path}`, async () => {
        const response = await request(path);

        assert.equal(response.status, 401);
    });
}

test("Admin dashboard redirects to login", async () => {
    const response = await request("/admin/monitoring");

    assert.equal(response.status, 303);

    assert.equal(
        response.headers.get("location"),
        "/admin/login"
    );
});

// 6. CORS

test("Unknown origin is rejected", async () => {
    const response = await request("/api/booking", {
        method: "OPTIONS",
        headers: {
            Origin: "https://untrusted.example",
            "Access-Control-Request-Method": "POST"
        }
    });

    assert.equal(response.status, 403);

    assert.equal(
        response.headers.get("access-control-allow-origin"),
        null
    );
});

test("Trusted frontend origin is accepted", async () => {
    const origin =
        "https://aladick9454-bot.github.io";

    const response = await request("/api/booking", {
        method: "OPTIONS",
        headers: {
            Origin: origin,
            "Access-Control-Request-Method": "POST"
        }
    });

    assert.equal(response.status, 204);

    assert.equal(
        response.headers.get("access-control-allow-origin"),
        origin
    );
});

// 7. Webhook authentication

test("Monitoring ingest requires a secret", async () => {
    const response = await request(
        "/api/monitoring/ingest",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({})
        }
    );

    assert.equal(response.status, 403);
});

// 8. Request body validation

test("Malformed JSON is rejected", async () => {
    const response = await request(
        "/api/monitoring/ingest",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: '{"invalid":'
        }
    );

    assert.equal(response.status, 400);
});

test("Oversized JSON is rejected", async () => {
    const response = await request(
        "/api/monitoring/ingest",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                data: "x".repeat(20000)
            })
        }
    );

    assert.equal(response.status, 413);
});
