const test = require("node:test");

const assert = require("node:assert/strict");

const { Pool } = require("pg");


const databaseUrl =

    process.env.CI_TEST_DATABASE_URL;


if (!databaseUrl) {

    throw new Error(

        "CI_TEST_DATABASE_URL is required"
    );
}


const pool = new Pool({

    connectionString: databaseUrl,

    max: 2,

    connectionTimeoutMillis: 15000,

    query_timeout: 20000
});


test.after(async () => {

    await pool.end();
});


test("PostgreSQL connection works", async () => {

    const result = await pool.query(

        "SELECT 1 AS value"
    );


    assert.equal(result.rows[0].value, 1);
});


test("Required monitoring tables exist", async () => {

    const required = [

        "monitoring_snapshots",

        "monitoring_incidents",

        "monitoring_heartbeats",

        "monitoring_cloud_checks",

        "security_events",

        "security_rate_limits",

        "security_ip_blocks",

        "security_protection_events",

        "monitoring_ci_runs",

        "schema_migrations",

        "database_metadata",

        "application_releases",

        "application_release_events"
    ];


    const result = await pool.query(`

        SELECT table_name

        FROM information_schema.tables

        WHERE table_schema = 'public'
    `);


    const existing = new Set(

        result.rows.map(row => row.table_name)
    );


    for (const name of required) {

        assert.ok(

            existing.has(name),

            `Missing table: ${name}`
        );
    }
});


test("CI summary view exists", async () => {

    const result = await pool.query(

        "SELECT * FROM monitoring_ci_summary"
    );


    assert.equal(result.rows.length, 1);
});


test("Rate limit SQL function rejects excess requests", async () => {

    const client = await pool.connect();


    try {

        await client.query("BEGIN");


        const scope =

            `ci_test_${Date.now()}_${process.pid}`;


        for (let i = 1; i <= 4; i++) {

            const result = await client.query(

                `

                SELECT *

                FROM consume_security_rate_limit(

                    $1::inet,

                    $2::text,

                    3600,

                    3,

                    FALSE
                )
                `,

                ["192.0.2.201", scope]
            );


            assert.equal(

                result.rows[0].allowed,

                i <= 3
            );


            assert.equal(

                result.rows[0].blocked,

                false
            );
        }

    } finally {

        try {

            await client.query("ROLLBACK");

        } finally {

            client.release();
        }
    }
});


test("Active IP block rejects requests", async () => {

    const client = await pool.connect();


    try {

        await client.query("BEGIN");


        await client.query(`

            INSERT INTO security_ip_blocks (

                ip_address,

                block_type,

                reason,

                expires_at
            )

            VALUES (

                '192.0.2.202',

                'manual',

                'Automated CI test',

                NOW() + INTERVAL '5 minutes'
            )
        `);


        const result = await client.query(`

            SELECT *

            FROM consume_security_rate_limit(

                '192.0.2.202'::inet,

                'ci_block_test',

                60,

                20,

                FALSE
            )
        `);


        assert.equal(

            result.rows[0].allowed,

            false
        );


        assert.equal(

            result.rows[0].blocked,

            true
        );

    } finally {

        try {

            await client.query("ROLLBACK");

        } finally {

            client.release();
        }
    }
});

test("Database migration history exists", async () => {

    const result = await pool.query(`

        SELECT

            version,

            checksum

        FROM public.schema_migrations

        ORDER BY version
    `);


    assert.ok(result.rows.length >= 2);


    for (const row of result.rows) {

        assert.match(

            row.checksum,

            /^[a-f0-9]{64}$/
        );
    }
});


test("Database migration summary is available", async () => {

    const result = await pool.query(`

        SELECT *

        FROM public.database_migration_summary
    `);


    assert.equal(result.rows.length, 1);


    assert.ok(

        Number(result.rows[0].total_migrations) >= 2
    );
});

test("Release summary is available", async () => {

    const result = await pool.query(`

        SELECT *

        FROM public.application_release_summary
    `);


    assert.equal(result.rows.length, 1);


    assert.ok(

        Number(result.rows[0].total_releases) >= 0
    );
});


test("Release events table is available", async () => {

    const result = await pool.query(`

        SELECT COUNT(*) AS count

        FROM public.application_release_events
    `);


    assert.ok(

        Number(result.rows[0].count) >= 0
    );
});


test("Release statuses are valid", async () => {

    const result = await pool.query(`

        SELECT COUNT(*) AS invalid_count

        FROM public.application_releases

        WHERE status NOT IN (

            'pending',

            'deploying',

            'verifying',

            'success',

            'failed',

            'rolling_back',

            'rolled_back',

            'rollback_failed'
        )
    `);


    assert.equal(

        Number(result.rows[0].invalid_count),

        0
    );
});