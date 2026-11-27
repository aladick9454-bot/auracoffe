const fs = require("node:fs");
const path = require("node:path");

const { Client } = require("pg");


async function main() {

    const target = process.env.MIGRATION_TARGET;

    if (!["test", "production"].includes(target)) {

        throw new Error(
            "Explicit MIGRATION_TARGET is required"
        );

    }

    if (

        target === "production" &&

        process.env.PERFORMANCE_SAVE_CONFIRM !==
            "SAVE_PRODUCTION_REPORT"

    ) {

        throw new Error(
            "Production report confirmation required"
        );

    }

    const connectionString = target === "test"

        ? process.env.CI_TEST_DATABASE_URL

        : process.env.PRODUCTION_DATABASE_URL;

    if (!connectionString) {

        throw new Error(
            "Database connection is missing"
        );

    }

    const file = path.resolve(

        process.env.PERFORMANCE_REPORT_PATH ||

        "reports/performance-latest.json"

    );

    const report = JSON.parse(

        fs.readFileSync(file, "utf8")

    );

    const client = new Client({

        connectionString,

        connectionTimeoutMillis: 15000,

        query_timeout: 30000

    });

    await client.connect();

    try {

        const result = await client.query(`

            INSERT INTO public.performance_test_runs (

                run_id,

                environment,

                endpoint,

                started_at,

                finished_at,

                duration_seconds,

                concurrency,

                total_requests,

                successful_requests,

                failed_requests,

                error_rate,

                requests_per_second,

                avg_latency_ms,

                p50_ms,

                p95_ms,

                p99_ms,

                max_latency_ms,

                status,

                details

            )

            VALUES (

                $1, $2, $3, $4, $5,

                $6, $7, $8, $9, $10,

                $11, $12, $13, $14, $15,

                $16, $17, $18, $19::jsonb

            )

            ON CONFLICT (run_id)

            DO NOTHING

            RETURNING id

        `, [

            report.run_id,

            report.environment,

            report.endpoint,

            report.started_at,

            report.finished_at,

            report.duration_seconds,

            report.concurrency,

            report.total_requests,

            report.successful_requests,

            report.failed_requests,

            report.error_rate,

            report.requests_per_second,

            report.avg_latency_ms,

            report.p50_ms,

            report.p95_ms,

            report.p99_ms,

            report.max_latency_ms,

            report.status,

            JSON.stringify(report.details || {})

        ]);

        console.log(

            result.rowCount

                ? "PERFORMANCE REPORT SAVED"

                : "PERFORMANCE REPORT ALREADY EXISTS"

        );

    } finally {

        await client.end();

    }

}


main().catch(error => {

    console.error(

        "PERFORMANCE SAVE FAILED:",

        error.code || error.message

    );

    process.exitCode = 1;

});