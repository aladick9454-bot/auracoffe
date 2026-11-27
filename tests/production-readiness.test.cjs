
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    checkRequiredFiles,
    checkRequiredScripts,
    validateBaseUrl,
    checkEndpoint,
    summarize
} = require("../scripts/production-readiness.cjs");

test("Existing required file passes", () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "aura-readiness-")
    );

    try {
        fs.writeFileSync(
            path.join(directory, "example.txt"),
            "test"
        );

        const results = checkRequiredFiles(
            directory,
            ["example.txt"]
        );

        assert.equal(results[0].passed, true);
    } finally {
        fs.rmSync(directory, {
            recursive: true,
            force: true
        });
    }
});

test("Missing required file fails", () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "aura-readiness-")
    );

    try {
        const results = checkRequiredFiles(
            directory,
            ["missing.txt"]
        );

        assert.equal(results[0].passed, false);
    } finally {
        fs.rmSync(directory, {
            recursive: true,
            force: true
        });
    }
});

test("Existing npm script passes", () => {
    const results = checkRequiredScripts(
        { start: "node server.js" },
        ["start"]
    );

    assert.equal(results[0].passed, true);
});

test("Missing npm script fails", () => {
    const results = checkRequiredScripts(
        {},
        ["start"]
    );

    assert.equal(results[0].passed, false);
});

test("Empty npm script fails", () => {
    const results = checkRequiredScripts(
        { start: "   " },
        ["start"]
    );

    assert.equal(results[0].passed, false);
});

test("HTTPS production URL is accepted", () => {
    assert.equal(
        validateBaseUrl("https://example.com"),
        true
    );
});

test("Local HTTP URL is accepted", () => {
    assert.equal(
        validateBaseUrl("http://127.0.0.1:3001"),
        true
    );
});

test("Insecure remote HTTP URL is rejected", () => {
    assert.equal(
        validateBaseUrl("http://example.com"),
        false
    );
});

test("Invalid URL is rejected", () => {
    assert.equal(
        validateBaseUrl("invalid-url"),
        false
    );
});

test("URL containing credentials is rejected", () => {
    assert.equal(
        validateBaseUrl(
            "https://user:password@example.com"
        ),
        false
    );
});

test("URL containing a path is rejected", () => {
    assert.equal(
        validateBaseUrl("https://example.com/api"),
        false
    );
});

test("Healthy endpoint passes", async () => {
    const mockFetch = async () => ({
        status: 200
    });

    const result = await checkEndpoint(
        "http://localhost:3001",
        "/health",
        mockFetch
    );

    assert.equal(result.passed, true);
    assert.equal(result.status, 200);
});

test("Unavailable endpoint fails", async () => {
    const mockFetch = async () => ({
        status: 503
    });

    const result = await checkEndpoint(
        "http://localhost:3001",
        "/ready",
        mockFetch
    );

    assert.equal(result.passed, false);
    assert.equal(result.status, 503);
});

test("Network failure is handled", async () => {
    const mockFetch = async () => {
        throw new Error("Connection failed");
    };

    const result = await checkEndpoint(
        "http://localhost:3001",
        "/health",
        mockFetch
    );

    assert.equal(result.passed, false);
});

test("All successful checks produce ready state", () => {
    const result = summarize([
        { passed: true },
        { passed: true }
    ]);

    assert.deepEqual(result, {
        total: 2,
        passed: 2,
        failed: 0,
        ready: true
    });
});

test("Failed check prevents ready state", () => {
    const result = summarize([
        { passed: true },
        { passed: false }
    ]);

    assert.deepEqual(result, {
        total: 2,
        passed: 1,
        failed: 1,
        ready: false
    });
});

test("Empty results are not ready", () => {
    const result = summarize([]);

    assert.equal(result.ready, false);
});