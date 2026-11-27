"use strict";

const test = require("node:test");

const assert = require("node:assert/strict");


const {

    isValidCommit,

    isFresh,

    validateVersion,

    validateConfirmation

} = require("../scripts/release-preflight.cjs");


const {

    FAILURE_STATUSES,

    ACTIVE_STATUSES,

    safeError

} = require("../scripts/release-manager.cjs");


test("Valid Git commit SHA is accepted", () => {

    assert.equal(

        isValidCommit("a".repeat(40)),

        true
    );
});


test("Invalid commit SHA is rejected", () => {

    assert.equal(

        isValidCommit("invalid"),

        false
    );
});


test("Semantic release version is accepted", () => {

    assert.equal(validateVersion("1.0.0"), true);

    assert.equal(validateVersion("v1.0.0"), true);
});


test("Invalid release version is rejected", () => {

    assert.equal(validateVersion("latest"), false);
});


test("Production confirmation is accepted", () => {

    assert.equal(

        validateConfirmation("RELEASE_PRODUCTION"),

        true
    );
});


test("Incorrect confirmation is rejected", () => {

    assert.equal(validateConfirmation("TEST"), false);
});


test("Recent backup passes freshness check", () => {

    const now = Date.now();

    const timestamp = new Date(
        now - 60 * 60 * 1000
    );


    assert.equal(

        isFresh(timestamp, 24, now),

        true
    );
});


test("Old backup fails freshness check", () => {

    const now = Date.now();

    const timestamp = new Date(
        now - 25 * 60 * 60 * 1000
    );


    assert.equal(

        isFresh(timestamp, 24, now),

        false
    );
});


test("Recent restore test is accepted", () => {

    const now = Date.now();

    const timestamp = new Date(
        now - 47 * 60 * 60 * 1000
    );


    assert.equal(

        isFresh(timestamp, 48, now),

        true
    );
});


test("Old restore test is rejected", () => {

    const now = Date.now();

    const timestamp = new Date(
        now - 49 * 60 * 60 * 1000
    );


    assert.equal(

        isFresh(timestamp, 48, now),

        false
    );
});


test("Missing timestamp is rejected", () => {

    assert.equal(isFresh(null, 24), false);
});


test("Invalid timestamp is rejected", () => {

    assert.equal(

        isFresh("invalid-date", 24),

        false
    );
});


test("Future timestamp is rejected", () => {

    const now = Date.now();


    assert.equal(

        isFresh(new Date(now + 60000), 24, now),

        false
    );
});


test("Render failure statuses are recognized", () => {

    assert.ok(FAILURE_STATUSES.has("build_failed"));

    assert.ok(FAILURE_STATUSES.has("update_failed"));

    assert.ok(FAILURE_STATUSES.has("pre_deploy_failed"));

    assert.equal(FAILURE_STATUSES.has("live"), false);
});


test("Active Render deployments are recognized", () => {

    assert.ok(ACTIVE_STATUSES.has("queued"));

    assert.ok(ACTIVE_STATUSES.has("build_in_progress"));

    assert.equal(ACTIVE_STATUSES.has("live"), false);
});


test("Error sanitization hides secret values", t => {

    const previous = process.env.RENDER_API_KEY;


    t.after(() => {

        if (previous === undefined) {

            delete process.env.RENDER_API_KEY;

        } else {

            process.env.RENDER_API_KEY = previous;
        }
    });


    process.env.RENDER_API_KEY = "test-secret-value";


    assert.equal(

        safeError(

            new Error("Error: test-secret-value")

        ),

        "Error: [REDACTED]"
    );
});