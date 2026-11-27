const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
    performance
} = require("node:perf_hooks");


const THRESHOLDS = Object.freeze({

    p95_ms: 500,

    p99_ms: 1000,

    error_rate: 1

});


function round(value) {

    return Math.round(value * 100) / 100;

}


function percentile(values, percent) {

    if (!values.length) {
        return 0;
    }

    const sorted = [...values].sort(
        (a, b) => a - b
    );

    const index = Math.max(
        0,
        Math.ceil(
            percent / 100 * sorted.length
        ) - 1
    );

    return sorted[index];

}


function evaluatePerformance(metrics) {

    return (

        metrics.total_requests > 0 &&

        metrics.p95_ms <= THRESHOLDS.p95_ms &&

        metrics.p99_ms <= THRESHOLDS.p99_ms &&

        metrics.error_rate <= THRESHOLDS.error_rate

    ) ? "passed" : "failed";

}


function readInteger(name, fallback, min, max) {

    const value = Number(
        process.env[name] || fallback
    );

    if (

        !Number.isInteger(value) ||

        value < min ||

        value > max

    ) {

        throw new Error(
            `Invalid configuration: ${name}`
        );

    }

    return value;

}


function validateTarget(value) {

    const url = new URL(value);

    const allowedHosts = [

        "localhost",

        "127.0.0.1",

        "[::1]"

    ];

    if (

        url.protocol !== "http:" ||

        !allowedHosts.includes(url.hostname) ||

        url.username ||

        url.password ||

        url.search ||

        url.hash ||

        url.pathname !== "/"

    ) {

        throw new Error(
            "Load testing is restricted to local HTTP servers"
        );

    }

    return url.origin;

}


function sleep(ms) {

    return new Promise(
        resolve => setTimeout(resolve, ms)
    );

}


function summarize(results, durationSeconds) {

    const latencies = results.map(
        item => item.latency
    );

    const successful = results.filter(
        item => item.ok
    ).length;

    const total = results.length;

    const failed = total - successful;

    const average = total

        ? latencies.reduce(
            (sum, value) => sum + value,
            0
        ) / total

        : 0;

    const metrics = {

        total_requests: total,

        successful_requests: successful,

        failed_requests: failed,

        error_rate: total
            ? failed / total * 100
            : 100,

        requests_per_second:
            total / durationSeconds,

        avg_latency_ms: average,

        p50_ms: percentile(latencies, 50),

        p95_ms: percentile(latencies, 95),

        p99_ms: percentile(latencies, 99),

        max_latency_ms: total
            ? Math.max(...latencies)
            : 0

    };

    return {

        ...Object.fromEntries(

            Object.entries(metrics).map(

                ([key, value]) => [
                    key,
                    round(value)
                ]

            )

        ),

        status: evaluatePerformance(metrics)

    };

}


async function executeRequest(url, endpoint) {

    const started = performance.now();

    let ok = false;

    let status = "network_error";

    try {

        const response = await fetch(url, {

            method: "GET",

            redirect: "error",

            signal: AbortSignal.timeout(5000)

        });

        status = String(response.status);

        const data = await response.json();

        if (endpoint === "/health") {

            ok = response.status === 200 &&
                data.status === "ok";

        } else {

            ok = response.status === 200 &&
                data.status === "ready" &&
                data.database === "healthy";

        }

    } catch {

        ok = false;

    }

    return {

        ok,

        status,

        latency: performance.now() - started

    };

}


async function runLoadTest() {

    const baseUrl = validateTarget(

        process.env.LOAD_TEST_BASE_URL ||

        "http://127.0.0.1:3000"

    );

    const endpoint =

        process.env.LOAD_TEST_ENDPOINT ||

        "/health";

    if (!["/health", "/ready"].includes(endpoint)) {

        throw new Error(
            "Unsupported load test endpoint"
        );

    }

    const duration = readInteger(
        "LOAD_TEST_DURATION", 30, 5, 120
    );

    const concurrency = readInteger(
        "LOAD_TEST_CONCURRENCY", 5, 1, 20
    );

    const rate = readInteger(
        "LOAD_TEST_RPS", 10, 1, 20
    );

    const environment = process.env.CI === "true"
        ? "ci"
        : "local";

    const url = `${baseUrl}${endpoint}`;

    const results = [];

    const interval = 1000 / rate;

    console.log("AURA COFFEE LOAD TEST");

    console.log("Target:", url);

    console.log("Duration:", duration);

    console.log("Concurrency:", concurrency);

    console.log("Maximum RPS:", rate);


    // Warm-up request

    const warmup = await executeRequest(
        url,
        endpoint
    );

    if (!warmup.ok) {

        throw new Error(
            "Target failed warm-up request"
        );

    }


    const startedAt = new Date();

    const started = performance.now();

    const deadline = started + duration * 1000;

    let nextSlot = started;


    async function worker() {

        while (performance.now() < deadline) {

            const slot = Math.max(

                nextSlot,

                performance.now()

            );

            nextSlot = slot + interval;

            if (slot >= deadline) {
                break;
            }

            await sleep(
                Math.max(
                    0,
                    slot - performance.now()
                )
            );

            if (performance.now() >= deadline) {
                break;
            }

            const result = await executeRequest(
                url,
                endpoint
            );

            results.push(result);

        }

    }


    await Promise.all(

        Array.from(

            { length: concurrency },

            () => worker()

        )

    );


    const elapsed =

        (performance.now() - started) / 1000;

    const finishedAt = new Date();

    const statusCodes = {};

    for (const result of results) {

        statusCodes[result.status] =

            (statusCodes[result.status] || 0) + 1;

    }

    const report = {

        run_id: crypto.randomUUID(),

        environment,

        endpoint,

        started_at: startedAt.toISOString(),

        finished_at: finishedAt.toISOString(),

        duration_seconds: round(elapsed),

        concurrency,

        ...summarize(results, elapsed),

        details: {

            status_codes: statusCodes,

            thresholds: THRESHOLDS,

            target_rps: rate,

            commit_sha:
                process.env.GITHUB_SHA || null

        }

    };


    const output = path.resolve(

        process.env.PERFORMANCE_REPORT_PATH ||

        "reports/performance-latest.json"

    );

    fs.mkdirSync(

        path.dirname(output),

        { recursive: true }

    );

    fs.writeFileSync(

        output,

        JSON.stringify(report, null, 2),

        "utf8"

    );

    console.table({

        requests: report.total_requests,

        successful: report.successful_requests,

        failed: report.failed_requests,

        rps: report.requests_per_second,

        p50: report.p50_ms,

        p95: report.p95_ms,

        p99: report.p99_ms,

        error_rate: report.error_rate,

        status: report.status

    });

    console.log("Report:", output);

    console.log(

        "PERFORMANCE TEST:",

        report.status.toUpperCase()

    );

    if (report.status !== "passed") {

        process.exitCode = 1;

    }

    return report;

}


if (require.main === module) {

    runLoadTest().catch(error => {

        console.error(

            "LOAD TEST FAILED:",

            error.message

        );

        process.exitCode = 1;

    });

}


module.exports = {

    percentile,

    summarize,

    evaluatePerformance,

    validateTarget

};