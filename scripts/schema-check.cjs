"use strict";

const crypto = require("node:crypto");

const { Client } = require("pg");


const queries = {

    tables: `

        SELECT

            c.relname AS name,

            c.relkind AS kind,

            c.relrowsecurity AS row_security,

            c.relforcerowsecurity AS force_row_security

        FROM pg_class c

        JOIN pg_namespace n

            ON n.oid = c.relnamespace

        WHERE n.nspname = 'public'

        AND c.relkind IN ('r', 'p', 'v', 'm', 'S')

        ORDER BY c.relname
    `,


    columns: `

        SELECT

            table_name,

            column_name,

            ordinal_position,

            data_type,

            udt_name,

            is_nullable,

            column_default,

            character_maximum_length,

            numeric_precision,

            numeric_scale,

            is_identity,

            identity_generation,

            is_generated,

            generation_expression

        FROM information_schema.columns

        WHERE table_schema = 'public'

        ORDER BY

            table_name,

            ordinal_position
    `,


    indexes: `

        SELECT

            tablename,

            indexname,

            indexdef

        FROM pg_indexes

        WHERE schemaname = 'public'

        ORDER BY tablename, indexname
    `,


    constraints: `

        SELECT

            c.relname AS table_name,

            con.conname AS constraint_name,

            con.contype AS constraint_type,

            pg_get_constraintdef(

                con.oid,

                false

            ) AS definition

        FROM pg_constraint con

        JOIN pg_class c

            ON c.oid = con.conrelid

        JOIN pg_namespace n

            ON n.oid = c.relnamespace

        WHERE n.nspname = 'public'

        ORDER BY c.relname, con.conname
    `,


    views: `

        SELECT

            c.relname AS view_name,

            pg_get_viewdef(

                c.oid,

                false

            ) AS definition

        FROM pg_class c

        JOIN pg_namespace n

            ON n.oid = c.relnamespace

        WHERE n.nspname = 'public'

        AND c.relkind IN ('v', 'm')

        ORDER BY c.relname
    `,


    functions: `

        SELECT

            p.proname AS function_name,

            pg_get_function_identity_arguments(

                p.oid

            ) AS arguments,

            pg_get_functiondef(

                p.oid

            ) AS definition

        FROM pg_proc p

        JOIN pg_namespace n

            ON n.oid = p.pronamespace

        WHERE n.nspname = 'public'

        AND p.prokind IN ('f', 'p')

        ORDER BY

            p.proname,

            pg_get_function_identity_arguments(p.oid)
    `,


    triggers: `

        SELECT

            c.relname AS table_name,

            t.tgname AS trigger_name,

            t.tgenabled AS enabled,

            pg_get_triggerdef(

                t.oid,

                false

            ) AS definition

        FROM pg_trigger t

        JOIN pg_class c

            ON c.oid = t.tgrelid

        JOIN pg_namespace n

            ON n.oid = c.relnamespace

        WHERE n.nspname = 'public'

        AND NOT t.tgisinternal

        ORDER BY c.relname, t.tgname
    `,


    policies: `

        SELECT

            tablename,

            policyname,

            permissive,

            roles,

            cmd,

            qual,

            with_check

        FROM pg_policies

        WHERE schemaname = 'public'

        ORDER BY tablename, policyname
    `
};


function checksum(value) {

    return crypto

        .createHash("sha256")

        .update(JSON.stringify(value))

        .digest("hex");
}


async function readSchema(connectionString) {

    const client = new Client({

        connectionString,

        connectionTimeoutMillis: 15000,

        query_timeout: 30000
    });


    await client.connect();


    try {

        const schema = {};


        await client.query(

            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        );


        try {

            for (const [name, sql] of Object.entries(queries)) {

                const result = await client.query(sql);


                schema[name] = result.rows;
            }


            await client.query("COMMIT");

        } catch (error) {

            await client.query("ROLLBACK");

            throw error;
        }


        return schema;

    } finally {

        await client.end();
    }
}


async function main() {

    const productionUrl =

        process.env.PRODUCTION_DATABASE_URL;


    const testUrl =

        process.env.CI_TEST_DATABASE_URL;


    if (!productionUrl || !testUrl) {

        throw new Error(

            "Both database URLs are required"
        );
    }


    if (productionUrl === testUrl) {

        throw new Error(

            "Database URLs must be different"
        );
    }


    console.log("AURA COFFEE SCHEMA COMPARISON");


    const [production, testing] = await Promise.all([

        readSchema(productionUrl),

        readSchema(testUrl)
    ]);


    let differences = 0;


    for (const name of Object.keys(queries)) {

        const same =

            checksum(production[name]) ===

            checksum(testing[name]);


        console.log(

            `[${same ? "MATCH" : "DIFFERENT"}] ${name}` +

            ` | production: ${production[name].length}` +

            ` | test: ${testing[name].length}`
        );


        if (!same) {

            differences++;
        }
    }


    console.log(

        "Production checksum:",

        checksum(production)
    );


    console.log(

        "Test checksum:",

        checksum(testing)
    );


    console.log(

        `Different categories: ${differences}`
    );


    if (differences > 0) {

        console.error("SCHEMA DRIFT DETECTED");

        process.exitCode = 1;

    } else {

        console.log("DATABASE SCHEMAS MATCH");
    }
}


main().catch(error => {

    console.error(

        "SCHEMA CHECK FAILED:",

        error.code || error.name
    );


    if (!error.code) {

        console.error(error.message);
    }


    process.exitCode = 1;
});