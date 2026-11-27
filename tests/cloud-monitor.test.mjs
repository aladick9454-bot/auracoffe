
import test from "node:test";
import assert from "node:assert/strict";

import {
    evaluateResponse,
    evaluateDatabase,
    calculateOverall
} from "../scripts/cloud-monitor.mjs";

test("Fast response is healthy", () => {
    assert.equal(
        evaluateResponse(
            { ok: true, status: 200 }, 150
        ).status,
        "healthy"
    );
});

test("Slow response produces warning", () => {
    assert.equal(
        evaluateResponse(
            { ok: true, status: 200 }, 2500
        ).status,
        "warning"
    );
});

test("Response at threshold produces warning", () => {
    assert.equal(
        evaluateResponse(
            { ok: true, status: 200 }, 2000
        ).status,
        "warning"
    );
});

test("HTTP 503 is critical", () => {
    assert.equal(
        evaluateResponse(
            { ok: false, status: 503 }, 100
        ).status,
        "critical"
    );
});

test("Valid readiness response is healthy", () => {
    assert.equal(
        evaluateResponse({
            ok: true,
            status: 200,
            data: { status: "ready" }
        }, 100, "ready").status,
        "healthy"
    );
});

test("Invalid readiness response is critical", () => {
    assert.equal(
        evaluateResponse({
            ok: true,
            status: 200,
            data: { status: "not_ready" }
        }, 100, "ready").status,
        "critical"
    );
});

test("Database outage is critical", () => {
    assert.equal(
        evaluateDatabase(
            { status: "critical" },
            { status: "healthy" }
        ).status,
        "critical"
    );
});

test("Database status is unknown when backend fails", () => {
    assert.equal(
        evaluateDatabase(
            { status: "critical" },
            { status: "critical" }
        ).status,
        "unknown"
    );
});

test("Slow database produces warning", () => {
    assert.equal(
        evaluateDatabase(
            { status: "warning", details: "2500 ms" },
            { status: "healthy" }
        ).status,
        "warning"
    );
});

test("All healthy components", () => {
    assert.equal(
        calculateOverall({
            website: { status: "healthy" },
            database: { status: "healthy" }
        }),
        "healthy"
    );
});

test("Warning affects overall status", () => {
    assert.equal(
        calculateOverall({
            website: { status: "healthy" },
            database: { status: "warning" }
        }),
        "warning"
    );
});

test("Critical status has highest priority", () => {
    assert.equal(
        calculateOverall({
            website: { status: "warning" },
            database: { status: "critical" }
        }),
        "critical"
    );
});

test("Unknown affects overall status", () => {
    assert.equal(
        calculateOverall({
            website: { status: "healthy" },
            database: { status: "unknown" }
        }),
        "unknown"
    );
});
