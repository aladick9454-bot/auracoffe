function registerPerformanceMonitoringRoutes(

    app,

    { pool, requireAdmin }

) {

    if (!pool || !requireAdmin) {

        throw new Error(
            "Performance monitoring dependencies missing"
        );

    }


    app.get(

        "/api/performance/summary",

        requireAdmin,

        async (req, res) => {

            res.set("Cache-Control", "no-store");

            try {

                const result = await pool.query(`

                    SELECT *

                    FROM public.performance_test_summary

                `);

                return res.json({

                    ok: true,

                    summary: result.rows[0]

                });

            } catch (error) {

                console.error(

                    "Performance summary error:",

                    error.code || error.name

                );

                return res.status(503).json({

                    ok: false,

                    error: "Performance data unavailable"

                });

            }

        }

    );


    app.get(

        "/api/performance/history",

        requireAdmin,

        async (req, res) => {

            res.set("Cache-Control", "no-store");

            const limit = Number(
                req.query.limit || 20
            );

            if (

                !Number.isInteger(limit) ||

                limit < 1 ||

                limit > 100

            ) {

                return res.status(400).json({

                    ok: false,

                    error: "Invalid limit"

                });

            }

            try {

                const result = await pool.query(`

                    SELECT

                        id,

                        run_id,

                        environment,

                        endpoint,

                        started_at,

                        duration_seconds,

                        concurrency,

                        total_requests,

                        failed_requests,

                        error_rate,

                        requests_per_second,

                        p50_ms,

                        p95_ms,

                        p99_ms,

                        status

                    FROM public.performance_test_runs

                    ORDER BY started_at DESC, id DESC

                    LIMIT $1

                `, [limit]);

                return res.json({

                    ok: true,

                    history: result.rows

                });

            } catch (error) {

                console.error(

                    "Performance history error:",

                    error.code || error.name

                );

                return res.status(503).json({

                    ok: false,

                    error: "Performance history unavailable"

                });

            }

        }

    );


    console.log(
        "Performance monitoring routes registered"
    );

}


module.exports = {

    registerPerformanceMonitoringRoutes

};