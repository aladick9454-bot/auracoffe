"use strict";

const {

    loadMigrations,

    compareMigrations

} = require("../scripts/migrate.cjs");


function registerMigrationMonitoringRoutes(

    app,

    { pool, requireAdmin }

) {

    app.get(

        "/api/migrations/summary",

        requireAdmin,

        async (req, res) => {

            res.set("Cache-Control", "no-store");


            try {

                const [summaryResult, historyResult] =

                    await Promise.all([

                        pool.query(`

                            SELECT *

                            FROM public.database_migration_summary
                        `),

                        pool.query(`

                            SELECT

                                version,

                                name,

                                checksum

                            FROM public.schema_migrations

                            ORDER BY version
                        `)
                    ]);


                const files = loadMigrations();


                let status = "healthy";

                let pendingCount = null;

                let reason = "All migrations verified";


                try {

                    const pending = compareMigrations(

                        files,

                        historyResult.rows
                    );


                    pendingCount = pending.length;


                    if (pendingCount > 0) {

                        status = "warning";

                        reason = "Pending migrations detected";
                    }

                } catch {

                    status = "critical";

                    reason = "Migration integrity check failed";
                }


                res.json({

                    ok: true,

                    generated_at:

                        new Date().toISOString(),

                    summary: {

                        ...summaryResult.rows[0],

                        available_migrations:

                            files.length,

                        pending_migrations:

                            pendingCount,

                        status,

                        reason
                    }
                });

            } catch (error) {

                console.error(

                    "Migration summary error:",

                    error.code || error.name
                );


                res.status(503).json({

                    ok: false,

                    error: "Migration summary unavailable"
                });
            }
        }
    );


    app.get(

        "/api/migrations/history",

        requireAdmin,

        async (req, res) => {

            res.set("Cache-Control", "no-store");


            try {

                const result = await pool.query(`

                    SELECT

                        version,

                        name,

                        checksum,

                        execution_ms,

                        applied_at

                    FROM public.schema_migrations

                    ORDER BY version DESC

                    LIMIT 100
                `);


                res.json({

                    ok: true,

                    migrations: result.rows
                });

            } catch (error) {

                console.error(

                    "Migration history error:",

                    error.code || error.name
                );


                res.status(503).json({

                    ok: false,

                    error: "Migration history unavailable"
                });
            }
        }
    );


    console.log(

        "Migration monitoring routes registered"
    );
}


module.exports = {

    registerMigrationMonitoringRoutes
};