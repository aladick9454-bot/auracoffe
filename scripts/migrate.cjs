"use strict";

const fs = require("node:fs");

const path = require("node:path");

const crypto = require("node:crypto");

const { Client } = require("pg");


const MIGRATIONS_DIRECTORY = path.resolve(

    __dirname,

    "../database/migrations"
);


const LOCK_ID = "80009001";


const BOOTSTRAP_SQL = `

    CREATE TABLE IF NOT EXISTS public.schema_migrations (

        version TEXT PRIMARY KEY,

        name TEXT NOT NULL,

        checksum TEXT NOT NULL
            CHECK (
                checksum ~ '^[a-f0-9]{64}$'
            ),

        execution_ms INTEGER NOT NULL
            DEFAULT 0
            CHECK (execution_ms >= 0),

        applied_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW()
    );
`;


function calculateChecksum(content) {

    const normalized = content

        .replace(/^\uFEFF/, "")

        .replace(/\r\n/g, "\n");


    return crypto

        .createHash("sha256")

        .update(normalized, "utf8")

        .digest("hex");
}


function validateMigrationSql(sql, filename) {

    if (!sql.trim()) {

        throw new Error(

            `Empty migration: ${filename}`
        );
    }


    const forbidden =

        /^\s*(BEGIN\s*;|START\s+TRANSACTION|COMMIT\s*;|ROLLBACK\s*;|END\s*;|ABORT\s*;|VACUUM\b|CREATE\s+DATABASE\b|DROP\s+DATABASE\b|ALTER\s+SYSTEM\b|CREATE\s+INDEX\s+CONCURRENTLY\b)/im;


    if (forbidden.test(sql)) {

        throw new Error(

            `Unsupported transaction command in ${filename}`
        );
    }
}


function loadMigrations(

    directory = MIGRATIONS_DIRECTORY

) {

    const filenames = fs.readdirSync(directory)

        .filter(name => name.endsWith(".sql"))

        .sort();


    if (!filenames.length) {

        throw new Error("No migrations found");
    }


    const versions = new Set();


    return filenames.map(filename => {

        const match = filename.match(

            /^(\d{4})_([a-z0-9_]+)\.sql$/
        );


        if (!match) {

            throw new Error(

                `Invalid migration filename: ${filename}`
            );
        }


        const version = match[1];


        if (versions.has(version)) {

            throw new Error(

                `Duplicate migration version: ${version}`
            );
        }


        versions.add(version);


        const sql = fs.readFileSync(

            path.join(directory, filename),

            "utf8"

        ).replace(/^\uFEFF/, "");


        validateMigrationSql(sql, filename);


        return {

            version,

            name: filename,

            sql,

            checksum: calculateChecksum(sql)
        };
    });
}


function compareMigrations(files, appliedRows) {

    const fileMap = new Map(

        files.map(file => [file.version, file])
    );


    const appliedMap = new Map(

        appliedRows.map(row => [row.version, row])
    );


    for (const row of appliedRows) {

        const file = fileMap.get(row.version);


        if (!file) {

            throw new Error(

                `Applied migration is missing: ${row.version}`
            );
        }


        if (

            file.checksum !== row.checksum ||

            file.name !== row.name

        ) {

            throw new Error(

                `Migration checksum or name mismatch: ${row.version}`
            );
        }
    }


    const pending = files.filter(

        file => !appliedMap.has(file.version)
    );


    const latestApplied = appliedRows

        .map(row => row.version)

        .sort()

        .at(-1);


    if (

        latestApplied &&

        pending.some(

            file => file.version < latestApplied
        )

    ) {

        throw new Error(

            "Out-of-order migration detected"
        );
    }


    return pending;
}


function getConfiguration() {

    const target = process.env.MIGRATION_TARGET;


    if (!["test", "production"].includes(target)) {

        throw new Error(

            "MIGRATION_TARGET must be test or production"
        );
    }


    const connectionString = target === "test"

        ? process.env.CI_TEST_DATABASE_URL

        : process.env.PRODUCTION_DATABASE_URL;


    if (!connectionString) {

        throw new Error(

            `Database URL missing for ${target}`
        );
    }


    const command = process.argv[2] || "status";


    if (!["status", "apply", "verify"].includes(command)) {

        throw new Error(

            "Command must be status, apply or verify"
        );
    }


    if (

        target === "production" &&

        command === "apply" &&

        process.env.MIGRATION_CONFIRM !== "APPLY_PRODUCTION"

    ) {

        throw new Error(

            "Production migration confirmation required"
        );
    }


    return {

        target,

        connectionString,

        command
    };
}


async function readAppliedMigrations(client) {

    const exists = await client.query(`

        SELECT to_regclass(

            'public.schema_migrations'

        ) IS NOT NULL AS exists
    `);


    if (!exists.rows[0].exists) {

        return [];
    }


    const result = await client.query(`

        SELECT

            version,

            name,

            checksum,

            execution_ms,

            applied_at

        FROM public.schema_migrations

        ORDER BY version
    `);


    return result.rows;
}


async function applyMigration(client, migration) {

    const startedAt = Date.now();


    console.log(

        `[APPLYING] ${migration.name}`
    );


    await client.query("BEGIN");


    try {

        await client.query(

            "SET LOCAL lock_timeout = '10s'"
        );


        await client.query(

            "SET LOCAL statement_timeout = '60s'"
        );


        await client.query(migration.sql);


        const duration = Date.now() - startedAt;


        await client.query(

            `

            INSERT INTO public.schema_migrations (

                version,

                name,

                checksum,

                execution_ms
            )

            VALUES ($1, $2, $3, $4)
            `,

            [

                migration.version,

                migration.name,

                migration.checksum,

                duration
            ]
        );


        await client.query("COMMIT");


        console.log(

            `[APPLIED] ${migration.name} (${duration} ms)`
        );

    } catch (error) {

        await client.query("ROLLBACK");


        console.error(

            `[ROLLED BACK] ${migration.name}`
        );


        throw error;
    }
}


async function main() {

    const config = getConfiguration();

    const migrations = loadMigrations();


    const client = new Client({

        connectionString: config.connectionString,

        connectionTimeoutMillis: 15000
    });


    let connected = false;

    let locked = false;


    try {

        await client.connect();

        connected = true;


        console.log("AURA COFFEE MIGRATION ENGINE");

        console.log(`Target: ${config.target}`);

        console.log(`Command: ${config.command}`);


        if (config.command === "apply") {

            const lock = await client.query(

                `

                SELECT pg_try_advisory_lock(

                    $1::bigint

                ) AS acquired
                `,

                [LOCK_ID]
            );


            locked = lock.rows[0].acquired;


            if (!locked) {

                throw new Error(

                    "Another migration process is running"
                );
            }
        }


        const applied = await readAppliedMigrations(

            client
        );


        const pending = compareMigrations(

            migrations,

            applied
        );


        console.log(

            `Available migrations: ${migrations.length}`
        );


        console.log(

            `Applied migrations: ${applied.length}`
        );


        console.log(

            `Pending migrations: ${pending.length}`
        );


        if (config.command === "status") {

            for (const migration of pending) {

                console.log(

                    `[PENDING] ${migration.name}`
                );
            }

            return;
        }


        if (config.command === "verify") {

            if (pending.length) {

                throw new Error(

                    "Pending migrations detected"
                );
            }


            console.log(

                "MIGRATION VERIFICATION PASSED"
            );

            return;
        }


        if (pending.length) {

            await client.query(BOOTSTRAP_SQL);
        }


        for (const migration of pending) {

            await applyMigration(client, migration);
        }


        const finalRows = await readAppliedMigrations(

            client
        );


        const remaining = compareMigrations(

            migrations,

            finalRows
        );


        if (remaining.length) {

            throw new Error(

                "Migration verification failed"
            );
        }


        console.log(

            "ALL MIGRATIONS APPLIED SUCCESSFULLY"
        );

    } finally {

        if (connected) {

            try {

                if (locked) {

                    await client.query(

                        "SELECT pg_advisory_unlock($1::bigint)",

                        [LOCK_ID]
                    );
                }

            } finally {

                await client.end();
            }
        }
    }
}


if (require.main === module) {

    main().catch(error => {

        console.error(

            "MIGRATION FAILED:",

            error.code || error.name
        );


        if (!error.code) {

            console.error(error.message);
        }


        process.exitCode = 1;
    });
}


module.exports = {

    calculateChecksum,

    validateMigrationSql,

    loadMigrations,

    compareMigrations
};
