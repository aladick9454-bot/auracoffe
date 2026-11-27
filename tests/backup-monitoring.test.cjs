
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    registerBackupMonitoringRoutes
} = require("../services/backup-monitoring.js");

function createTestApp() {

    const routes = new Map();

    const app = {
        post(path, ...handlers) {
            routes.set(`POST ${path}`, handlers);
        },

        get(path, ...handlers) {
            routes.set(`GET ${path}`, handlers);
        }
    };

    const pool = {
        async query() {
            return {
                rows: [],
                rowCount: 0
            };
        }
    };

    const requireAdmin = () => {};

    registerBackupMonitoringRoutes(app, {
        pool,
        requireAdmin
    });

    return routes;
}

test("Backup ingest route exists", () => {

    const routes = createTestApp();

    assert.ok(
        routes.has(
            "POST /api/monitoring/backups/ingest"
        )
    );

});

test("Restore ingest route exists", () => {

    const routes = createTestApp();

    assert.ok(
        routes.has(
            "POST /api/monitoring/backups/restore-ingest"
        )
    );

});

test("Backup dashboard route exists", () => {

    const routes = createTestApp();

    assert.ok(
        routes.has(
            "GET /api/monitoring/backups/admin"
        )
    );

});

test("Missing dependencies are rejected", () => {

    assert.throws(
        () => registerBackupMonitoringRoutes({}, {}),
        /dependencies missing/
    );

});

test("Backup ingest has authentication middleware", () => {

    const routes = createTestApp();

    const handlers = routes.get(
        "POST /api/monitoring/backups/ingest"
    );

    assert.equal(handlers.length, 2);

    assert.equal(
        handlers[0].name,
        "requireBackupSecret"
    );

});

test("Restore ingest has authentication middleware", () => {

    const routes = createTestApp();

    const handlers = routes.get(
        "POST /api/monitoring/backups/restore-ingest"
    );

    assert.equal(handlers.length, 2);

    assert.equal(
        handlers[0].name,
        "requireBackupSecret"
    );

});

test("Invalid backup payload is rejected", async () => {

    const routes = createTestApp();

    const handlers = routes.get(
        "POST /api/monitoring/backups/ingest"
    );

    let statusCode = 200;

    const req = {
        body: {}
    };

    const res = {
        status(code) {
            statusCode = code;
            return this;
        },

        json(data) {
            return data;
        }
    };

    const result = await handlers[1](req, res);

    assert.equal(statusCode, 400);
    assert.equal(result.ok, false);

});

test("Invalid restore payload is rejected", async () => {

    const routes = createTestApp();

    const handlers = routes.get(
        "POST /api/monitoring/backups/restore-ingest"
    );

    let statusCode = 200;

    const req = {
        body: {}
    };

    const res = {
        status(code) {
            statusCode = code;
            return this;
        },

        json(data) {
            return data;
        }
    };

    const result = await handlers[1](req, res);

    assert.equal(statusCode, 400);
    assert.equal(result.ok, false);

});
