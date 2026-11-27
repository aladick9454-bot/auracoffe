const test = require("node:test");

const assert = require("node:assert/strict");

const {

    percentile,

    summarize,

    evaluatePerformance,

    validateTarget

} = require("../scripts/load-test.cjs");


test("P50 calculation works", () => {

    assert.equal(

        percentile([10, 20, 30, 40, 50], 50),

        30

    );

});


test("P95 calculation works", () => {

    const values = Array.from(

        { length: 100 },

        (_, index) => index + 1

    );

    assert.equal(

        percentile(values, 95),

        95

    );

});


test("P99 calculation works", () => {

    const values = Array.from(

        { length: 100 },

        (_, index) => index + 1

    );

    assert.equal(

        percentile(values, 99),

        99

    );

});


test("Empty percentile is zero", () => {

    assert.equal(

        percentile([], 95),

        0

    );

});


test("Healthy performance passes", () => {

    assert.equal(

        evaluatePerformance({

            total_requests: 100,

            p95_ms: 200,

            p99_ms: 400,

            error_rate: 0

        }),

        "passed"

    );

});


test("High P95 fails", () => {

    assert.equal(

        evaluatePerformance({

            total_requests: 100,

            p95_ms: 700,

            p99_ms: 800,

            error_rate: 0

        }),

        "failed"

    );

});


test("High P99 fails", () => {

    assert.equal(

        evaluatePerformance({

            total_requests: 100,

            p95_ms: 300,

            p99_ms: 1500,

            error_rate: 0

        }),

        "failed"

    );

});


test("High error rate fails", () => {

    assert.equal(

        evaluatePerformance({

            total_requests: 100,

            p95_ms: 100,

            p99_ms: 200,

            error_rate: 5

        }),

        "failed"

    );

});


test("Empty test fails", () => {

    assert.equal(

        evaluatePerformance({

            total_requests: 0,

            p95_ms: 0,

            p99_ms: 0,

            error_rate: 0

        }),

        "failed"

    );

});


test("Local target is accepted", () => {

    assert.equal(

        validateTarget(
            "http://127.0.0.1:3000"
        ),

        "http://127.0.0.1:3000"

    );

});


test("Production target is rejected", () => {

    assert.throws(() => {

        validateTarget(

            "https://aura-coffee-api-2lty.onrender.com"

        );

    });

});


test("Remote HTTP target is rejected", () => {

    assert.throws(() => {

        validateTarget("http://example.com");

    });

});


test("Performance summary is calculated", () => {

    const result = summarize([

        { ok: true, latency: 10 },

        { ok: true, latency: 20 },

        { ok: false, latency: 30 },

        { ok: true, latency: 40 }

    ], 2);

    assert.equal(result.total_requests, 4);

    assert.equal(result.successful_requests, 3);

    assert.equal(result.failed_requests, 1);

    assert.equal(result.error_rate, 25);

    assert.equal(result.requests_per_second, 2);

    assert.equal(result.avg_latency_ms, 25);

    assert.equal(result.status, "failed");

});