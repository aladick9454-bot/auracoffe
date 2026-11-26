const crypto = require("node:crypto");


function registerCiMonitoringRoutes(

    app,

    { pool, requireAdmin }

) {

    function requireCiSecret(req, res, next) {

        const expected =

            process.env.CI_MONITOR_SECRET || "";


        const provided =

            req.get("x-ci-monitor-secret") || "";


        if (expected.length < 32) {

            return res.status(503).json({

                ok: false,

                error: "CI monitoring not configured"
            });
        }


        const expectedBuffer = Buffer.from(expected);

        const providedBuffer = Buffer.from(provided);


        if (

            expectedBuffer.length !== providedBuffer.length ||

            !crypto.timingSafeEqual(

                expectedBuffer,

                providedBuffer
            )

        ) {

            return res.status(401).json({

                ok: false,

                error: "Unauthorized"
            });
        }


        next();
    }


    function validPayload(body) {

        if (!body || typeof body !== "object") {

            return false;
        }


        if (

            typeof body.run_id !== "string" ||

            !/^\d{1,24}-\d{1,10}$/.test(body.run_id)

        ) {

            return false;
        }


        if (

            !["ci", "production-smoke"]

                .includes(body.workflow_name)

        ) {

            return false;
        }


        if (

            typeof body.commit_sha !== "string" ||

            !/^[a-f0-9]{40}$/i.test(body.commit_sha)

        ) {

            return false;
        }


        if (

            typeof body.branch_name !== "string" ||

            body.branch_name.length < 1 ||

            body.branch_name.length > 250

        ) {

            return false;
        }


        if (

            !["success", "failure", "cancelled"]

                .includes(body.status)

        ) {

            return false;
        }


        if (

            !Number.isInteger(body.duration_seconds) ||

            body.duration_seconds < 0 ||

            body.duration_seconds > 86400

        ) {

            return false;
        }


        const runNumber = body.run_id.split("-")[0];


        const expectedUrl =

            "https://github.com/aladick9454-bot/" +

            "auracoffe/actions/runs/" +

            runNumber;


        return body.run_url === expectedUrl;
    }


    app.post(

        "/api/ci/ingest",

        requireCiSecret,

        async (req, res) => {

            if (!req.is("application/json")) {

                return res.status(415).json({

                    ok: false,

                    error: "JSON required"
                });
            }


            if (!validPayload(req.body)) {

                return res.status(400).json({

                    ok: false,

                    error: "Invalid CI payload"
                });
            }


            const data = req.body;


            try {

                const result = await pool.query(

                    `

                    INSERT INTO monitoring_ci_runs (

                        run_id,

                        workflow_name,

                        commit_sha,

                        branch_name,

                        status,

                        duration_seconds,

                        run_url
                    )

                    VALUES (

                        $1, $2, $3, $4,

                        $5, $6, $7
                    )

                    ON CONFLICT (run_id)

                    DO NOTHING

                    RETURNING id
                    `,

                    [

                        data.run_id,

                        data.workflow_name,

                        data.commit_sha,

                        data.branch_name,

                        data.status,

                        data.duration_seconds,

                        data.run_url
                    ]
                );


                res.json({

                    ok: true,

                    inserted: result.rowCount > 0
                });

            } catch (error) {

                console.error(

                    "CI ingestion error:",

                    error.code || error.name
                );


                res.status(503).json({

                    ok: false,

                    error: "CI storage unavailable"
                });
            }
        }
    );


    app.get(

        "/api/ci/summary",

        requireAdmin,

        async (req, res) => {

            res.set("Cache-Control", "no-store");


            try {

                const result = await pool.query(

                    "SELECT * FROM monitoring_ci_summary"
                );


                res.json({

                    ok: true,

                    generated_at:

                        new Date().toISOString(),

                    summary: result.rows[0]
                });

            } catch (error) {

                console.error(

                    "CI summary error:",

                    error.code || error.name
                );


                res.status(503).json({

                    ok: false,

                    error: "CI summary unavailable"
                });
            }
        }
    );


    app.get(

        "/api/ci/runs",

        requireAdmin,

        async (req, res) => {

            res.set("Cache-Control", "no-store");


            try {

                const result = await pool.query(`

                    SELECT *

                    FROM monitoring_ci_runs

                    ORDER BY checked_at DESC, id DESC

                    LIMIT 50
                `);


                res.json({

                    ok: true,

                    runs: result.rows
                });

            } catch (error) {

                console.error(

                    "CI history error:",

                    error.code || error.name
                );


                res.status(503).json({

                    ok: false,

                    error: "CI history unavailable"
                });
            }
        }
    );


    console.log("CI monitoring routes registered");
}


module.exports = {

    registerCiMonitoringRoutes
};