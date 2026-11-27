import test from "node:test";

import assert from "node:assert/strict";

import {
    evaluateDatabase,
    calculateOverall,
    evaluateResponse
} from "../scripts/cloud-monitor.mjs";


// ==========================================
// DATABASE RECOVERY
// ==========================================

test("Database outage and recovery", () => {

    const backend = {
        status: "healthy"
    };

    const failed = evaluateDatabase(
        {
            status: "critical",
            details: "Connection failed"
        },
        backend
    );

    assert.equal(
        failed.status,
        "critical"
    );

    const recovered = evaluateDatabase(
        {
            status: "healthy",
            details: "HTTP 200"
        },
        backend
    );

    assert.equal(
        recovered.status,
        "healthy"
    );

});


// ==========================================
// BACKEND OUTAGE
// ==========================================

test("Backend outage does not confirm database failure", () => {

    const result = evaluateDatabase(
        {
            status: "critical"
        },
        {
            status: "critical"
        }
    );

    assert.equal(
        result.status,
        "unknown"
    );

});


// ==========================================
// DATABASE PERFORMANCE
// ==========================================

test("Slow database produces warning", () => {

    const result = evaluateDatabase(
        {
            status: "warning",
            details: "Slow response"
        },
        {
            status: "healthy"
        }
    );

    assert.equal(
        result.status,
        "warning"
    );

});


// ==========================================
// SYSTEM RECOVERY
// ==========================================

test("Overall status returns to healthy after recovery", () => {

    const components = {

        website: {
            status: "healthy"
        },

        backend: {
            status: "critical"
        },

        database: {
            status: "unknown"
        }

    };

    assert.equal(
        calculateOverall(components),
        "critical"
    );

    components.backend.status = "healthy";

    components.database.status = "healthy";

    assert.equal(
        calculateOverall(components),
        "healthy"
    );

});


// ==========================================
// HTTP RECOVERY
// ==========================================

test("HTTP service recovers after failure", () => {

    const failed = evaluateResponse(
        {
            ok: false,
            status: 503
        },
        100
    );

    assert.equal(
        failed.status,
        "critical"
    );

    const recovered = evaluateResponse(
        {
            ok: true,
            status: 200,
            data: {
                status: "ok"
            }
        },
        150,
        "ok"
    );

    assert.equal(
        recovered.status,
        "healthy"
    );

});