"use strict";

const { Client } = require("pg");

const MAX_BACKUP_AGE_HOURS = 24;
const MAX_RESTORE_AGE_HOURS = 48;

const SUCCESS_STATUSES = [
    "success",
    "successful",
    "completed",
    "passed"
];


function isValidCommit(value) {

    return typeof value === "string" &&
        /^[a-f0-9]{40}$/.test(value);
}


function isFresh(timestamp, maxHours, now = Date.now()) {

    if (!timestamp) {
        return false;
    }

    const time = new Date(timestamp).getTime();

    if (!Number.isFinite(time)) {
        return false;
    }

    const age = now - time;

    return age >= 0 &&
        age <= maxHours * 60 * 60 * 1000;
}


function validateVersion(version) {

    return typeof version === "string" &&
        /^v?\d+\.\d+\.\d+$/.test(version);
}


function validateConfirmation(value) {

    return value === "RELEASE_PRODUCTION";
}


function validateEnvironment() {

    const required = [

        "PRODUCTION_DATABASE_URL",

        "CI_TEST_DATABASE_URL",

        "RENDER_API_KEY",

        "RENDER_SERVICE_ID",

        "RELEASE_VERSION",

        "RELEASE_CONFIRMATION",

        "GITHUB_SHA"
    ];


    for (const name of required) {

        if (!process.env[name]) {

            throw new Error(
                `Missing environment variable: ${name}`
            );
        }
    }


    if (!validateConfirmation(
        process.env.RELEASE_CONFIRMATION
    )) {

        throw new Error(
            "Production release confirmation required"
        );
    }


    if (!validateVersion(
        process.env.RELEASE_VERSION
    )) {

        throw new Error("Invalid release version");
    }


    if (!isValidCommit(process.env.GITHUB_SHA)) {

        throw new Error("Invalid commit SHA");
    }


    if (process.env.GITHUB_REF !== "refs/heads/main") {

        throw new Error(
            "Production releases require main branch"
        );
    }


    const production = new URL(
        process.env.PRODUCTION_DATABASE_URL
    );


    const testing = new URL(
        process.env.CI_TEST_DATABASE_URL
    );


    const normalizeHost = hostname =>

        hostname.replace("-pooler.", ".");


    if (

        normalizeHost(production.hostname) ===
        normalizeHost(testing.hostname)

        && production.pathname === testing.pathname

    ) {

        throw new Error(
            "Production and test databases must be different"
        );
    }
}


async function readLatestSuccessfulRecord(
    client,
    table,
    timestampColumn
) {

    const allowed = {

        monitoring_backup_runs: [
            "finished_at",
            "completed_at",
            "backup_at",
            "created_at"
        ],

        monitoring_restore_tests: [
            "finished_at",
            "completed_at",
            "tested_at",
            "created_at"
        ]
    };


    if (!allowed[table]) {

        throw new Error("Invalid table");
    }


    const columnsResult = await client.query(

        `SELECT column_name

         FROM information_schema.columns

         WHERE table_schema = 'public'

         AND table_name = $1`,

        [table]
    );


    const columns = columnsResult.rows.map(
        row => row.column_name
    );


    const statusColumn = [

        "status",

        "backup_status",

        "restore_status",

        "overall_status"

    ].find(name => columns.includes(name));


    const timeColumn = [

        timestampColumn,

        ...allowed[table]

    ].find(name =>

        allowed[table].includes(name) &&
        columns.includes(name)
    );


    if (!statusColumn || !timeColumn) {

        throw new Error(
            `Unsupported backup table structure: ${table}`
        );
    }


    const result = await client.query(

        `SELECT "${timeColumn}" AS completed_at

         FROM public."${table}"

         WHERE LOWER("${statusColumn}"::text)
               = ANY($1::text[])

         AND "${timeColumn}" IS NOT NULL

         ORDER BY "${timeColumn}" DESC

         LIMIT 1`,

        [SUCCESS_STATUSES]
    );


    return result.rows[0] || null;
}


async function checkActiveReleases(client) {

    const exists = await client.query(`

        SELECT to_regclass(
            'public.application_releases'
        ) IS NOT NULL AS exists
    `);


    if (!exists.rows[0].exists) {

        return;
    }


    const result = await client.query(`

        SELECT COUNT(*) AS count

        FROM public.application_releases

        WHERE status IN (

            'pending',

            'deploying',

            'verifying',

            'rolling_back'
        )
    `);


    if (Number(result.rows[0].count) > 0) {

        throw new Error(
            "An unfinished release requires investigation"
        );
    }
}


async function main() {

    validateEnvironment();


    const client = new Client({

        connectionString:
            process.env.PRODUCTION_DATABASE_URL,

        connectionTimeoutMillis: 15000,

        query_timeout: 30000
    });


    await client.connect();


    try {

        await client.query(
            "BEGIN READ ONLY"
        );


        const backup = await readLatestSuccessfulRecord(

            client,

            "monitoring_backup_runs",

            "finished_at"
        );


        const restore = await readLatestSuccessfulRecord(

            client,

            "monitoring_restore_tests",

            "finished_at"
        );


        if (!isFresh(
            backup?.completed_at,
            MAX_BACKUP_AGE_HOURS
        )) {

            throw new Error(
                "Successful backup is missing or older than 24 hours"
            );
        }


        console.log("BACKUP FRESHNESS: PASSED");


        if (!isFresh(
            restore?.completed_at,
            MAX_RESTORE_AGE_HOURS
        )) {

            throw new Error(
                "Successful restore test is missing or older than 48 hours"
            );
        }


        console.log("RESTORE FRESHNESS: PASSED");


        await checkActiveReleases(client);


        console.log("ACTIVE RELEASE CHECK: PASSED");


        await client.query("COMMIT");


        console.log("RELEASE PREFLIGHT PASSED");

    } finally {

        await client.end();
    }
}


if (require.main === module) {

    main().catch(error => {

        console.error(

            "RELEASE PREFLIGHT FAILED:",

            error.code || error.message
        );

        process.exitCode = 1;
    });
}


module.exports = {

    isValidCommit,

    isFresh,

    validateVersion,

    validateConfirmation
};