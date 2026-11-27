"use strict";


function registerReleaseMonitoringRoutes(

    app,

    { pool, requireAdmin }

) {

    app.get(

        "/api/releases/summary",

        requireAdmin,

        async (req, res) => {

            res.set("Cache-Control", "no-store");


            try {

                const [summary, latest] =

                    await Promise.all([

                        pool.query(`

                            SELECT *

                            FROM public.application_release_summary
                        `),

                        pool.query(`

                            SELECT

                                id,

                                release_version,

                                commit_sha,

                                status,

                                migration_version,

                                started_at,

                                finished_at

                            FROM public.application_releases

                            ORDER BY started_at DESC

                            LIMIT 1
                        `)
                    ]);


                res.json({

                    ok: true,

                    generated_at:
                        new Date().toISOString(),

                    summary: summary.rows[0],

                    latest_release:
                        latest.rows[0] || null
                });

            } catch (error) {

                console.error(

                    "Release summary error:",

                    error.code || error.name
                );


                res.status(503).json({

                    ok: false,

                    error: "Release summary unavailable"
                });
            }
        }
    );


    app.get(

        "/api/releases/history",

        requireAdmin,

        async (req, res) => {

            res.set("Cache-Control", "no-store");


            try {

                const result = await pool.query(`

                    SELECT

                        id,

                        run_id,

                        release_version,

                        commit_sha,

                        status,

                        migration_version,

                        smoke_passed,

                        duration_ms,

                        started_at,

                        finished_at

                    FROM public.application_releases

                    ORDER BY started_at DESC

                    LIMIT 100
                `);


                res.json({

                    ok: true,

                    releases: result.rows
                });

            } catch (error) {

                console.error(

                    "Release history error:",

                    error.code || error.name
                );


                res.status(503).json({

                    ok: false,

                    error: "Release history unavailable"
                });
            }
        }
    );


    app.get(

        "/api/releases/:id/events",

        requireAdmin,

        async (req, res) => {

            res.set("Cache-Control", "no-store");


            const id = String(req.params.id);


            if (!/^[1-9]\d{0,17}$/.test(id)) {

                return res.status(400).json({

                    ok: false,

                    error: "Invalid release ID"
                });
            }


            try {

                const release = await pool.query(

                    `SELECT id

                     FROM public.application_releases

                     WHERE id = $1`,

                    [id]
                );


                if (!release.rows.length) {

                    return res.status(404).json({

                        ok: false,

                        error: "Release not found"
                    });
                }


                const result = await pool.query(

                    `SELECT

                        event_type,

                        message,

                        created_at

                     FROM public.application_release_events

                     WHERE release_id = $1

                     ORDER BY created_at ASC, id ASC

                     LIMIT 200`,

                    [id]
                );


                res.json({

                    ok: true,

                    events: result.rows
                });

            } catch (error) {

                console.error(

                    "Release events error:",

                    error.code || error.name
                );


                res.status(503).json({

                    ok: false,

                    error: "Release events unavailable"
                });
            }
        }
    );


    console.log(

        "Release monitoring routes registered"
    );
}


module.exports = {

    registerReleaseMonitoringRoutes
};