"use strict";

const crypto = require("crypto");

const STATUSES = [
    "healthy",
    "warning",
    "critical",
    "unknown"
];

const COMPONENT_KEYS = [
    "local_n8n",
    "website",
    "backend",
    "database",
    "central_monitoring",
    "backup_system"
];

function secureCompare(received, expected) {
    if (
        typeof received !== "string" ||
        typeof expected !== "string" ||
        expected.length < 32
    ) {
        return false;
    }

    const a = Buffer.from(received, "utf8");
    const b = Buffer.from(expected, "utf8");

    return a.length === b.length &&
        crypto.timingSafeEqual(a, b);
}

function requireSecret(envName, headerName) {
    return (req, res, next) => {
        res.set("Cache-Control", "no-store");

        const expected = process.env[envName];

        if (!expected || expected.length < 32) {
            return res.status(503).json({
                ok: false,
                error: "Monitoring service unavailable"
            });
        }

        if (!secureCompare(
            req.get(headerName),
            expected
        )) {
            return res.status(401).json({
                ok: false,
                error: "Unauthorized"
            });
        }

        if (
            req.method === "POST" &&
            !req.is("application/json")
        ) {
            return res.status(415).json({
                ok: false,
                error: "JSON required"
            });
        }

        next();
    };
}

function classifyAge(value, warning, critical) {
    if (value === null || value === undefined) {
        return "unknown";
    }

    const age = Number(value);

    if (!Number.isFinite(age) || age < -5) {
        return "unknown";
    }

    if (age > critical) {
        return "critical";
    }

    if (age > warning) {
        return "warning";
    }

    return "healthy";
}

function calculateOverall(components) {
    const statuses = Object.values(components)
        .map(item => item.status);

    if (statuses.includes("critical")) {
        return "critical";
    }

    if (statuses.includes("warning")) {
        return "warning";
    }

    if (statuses.includes("unknown")) {
        return "unknown";
    }

    return "healthy";
}

function validRunId(value) {
    return typeof value === "string" &&
        /^\d{1,24}-\d{1,10}$/.test(value);
}

function validTimestamp(value) {
    if (typeof value !== "string") {
        return false;
    }

    const timestamp = Date.parse(value);

    if (!Number.isFinite(timestamp)) {
        return false;
    }

    const age = Date.now() - timestamp;

    return age >= -300000 &&
        age <= 3600000;
}

function normalizeComponents(input) {
    if (!input || typeof input !== "object") {
        return null;
    }

    const components = {};

    for (const key of COMPONENT_KEYS) {
        const item = input[key];

        if (
            !item ||
            !STATUSES.includes(item.status) ||
            typeof item.details !== "string" ||
            item.details.length > 300
        ) {
            return null;
        }

        components[key] = {
            status: item.status,
            details: item.details
        };
    }

    return components;
}

function makeSignature(components) {
    return COMPONENT_KEYS
        .map(key => `${key}:${components[key].status}`)
        .join("|");
}

async function getLocalState(pool) {
    const [
        heartbeatResult,
        centralResult,
        backupResult
    ] = await Promise.all([

        pool.query(`
            SELECT *
            FROM monitoring_heartbeat_health
        `),

        pool.query(`
            SELECT
                checked_at,
                overall_status,

                ROUND(
                    EXTRACT(EPOCH FROM (
                        NOW() - checked_at
                    )) / 60,
                    2
                ) AS age_minutes

            FROM monitoring_snapshots

            ORDER BY checked_at DESC

            LIMIT 1
        `),

        pool.query(`
            SELECT *
            FROM monitoring_backup_health
        `)

    ]);

    const heartbeat =
        heartbeatResult.rows[0] || {};

    const central =
        centralResult.rows[0] || null;

    const backup =
        backupResult.rows[0] || {};

    let centralStatus = classifyAge(
        central?.age_minutes,
        45,
        90
    );

    if (
        centralStatus === "healthy" &&
        STATUSES.includes(central?.overall_status)
    ) {
        centralStatus = central.overall_status;
    }

    const localComponents = {

        local_n8n: {
            status: heartbeat.status || "unknown",

            details: heartbeat.last_seen_at
                ? `Heartbeat age: ${
                    heartbeat.age_minutes
                } min`
                : "Heartbeat not registered"
        },

        database: {
            status: "healthy",
            details: "PostgreSQL queries successful"
        },

        central_monitoring: {
            status: centralStatus,

            details: central
                ? `Snapshot age: ${
                    central.age_minutes
                } min; status: ${
                    central.overall_status
                }`
                : "Central snapshot unavailable"
        },

        backup_system: {
            status: backup.overall_status || "unknown",

            details: backup.status_reason ||
                "Backup data unavailable"
        }
    };

    return {
        components: localComponents,
        heartbeat,
        central,
        backup
    };
}

function registerCloudMonitoringRoutes(
    app,
    { pool, requireAdmin }
) {
    if (!pool || !requireAdmin) {
        throw new Error(
            "Cloud monitoring dependencies missing"
        );
    }

    const requireHeartbeatSecret = requireSecret(
        "HEARTBEAT_SECRET",
        "x-heartbeat-secret"
    );

    const requireCloudSecret = requireSecret(
        "CLOUD_MONITOR_SECRET",
        "x-cloud-monitor-secret"
    );

    // ======================================
    // RECEIVE LOCAL HEARTBEAT
    // ======================================

    app.post(
        "/api/monitoring/heartbeat",

        requireHeartbeatSecret,

        async (req, res) => {
            const data = req.body;

            if (
                !data ||
                data.source !== "local_n8n" ||
                typeof data.execution_id !== "string" ||
                data.execution_id.length > 100
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "Invalid heartbeat payload"
                });
            }

            try {
                const result = await pool.query(
                    `
                    INSERT INTO monitoring_heartbeats (
                        source,
                        last_seen_at,
                        execution_id,
                        received_count
                    )

                    VALUES ($1, NOW(), $2, 1)

                    ON CONFLICT (source)
                    DO UPDATE SET
                        last_seen_at = NOW(),
                        execution_id = EXCLUDED.execution_id,

                        received_count =
                            monitoring_heartbeats.received_count + 1,

                        updated_at = NOW()

                    RETURNING
                        source,
                        last_seen_at,
                        received_count
                    `,
                    [
                        data.source,
                        data.execution_id
                    ]
                );

                return res.json({
                    ok: true,
                    heartbeat: result.rows[0]
                });

            } catch (error) {
                console.error(
                    "Heartbeat error:",
                    error.code || error.name
                );

                return res.status(503).json({
                    ok: false,
                    error: "Heartbeat storage unavailable"
                });
            }
        }
    );

    // ======================================
    // CLOUD STATE API
    // ======================================

    app.get(
        "/api/monitoring/cloud/state",

        requireCloudSecret,

        async (req, res) => {
            try {
                const state = await getLocalState(pool);

                return res.json({
                    ok: true,
                    generated_at: new Date().toISOString(),
                    ...state
                });

            } catch (error) {
                console.error(
                    "Cloud state error:",
                    error.code || error.name
                );

                return res.status(503).json({
                    ok: false,
                    error: "Cloud state unavailable"
                });
            }
        }
    );

    // ======================================
    // SAVE CLOUD CHECK
    // ======================================

    app.post(
        "/api/monitoring/cloud/ingest",

        requireCloudSecret,

        async (req, res) => {
            const data = req.body;

            const components =
                normalizeComponents(data?.components);

            if (
                !data ||
                !validRunId(data.run_id) ||
                !validTimestamp(data.checked_at) ||
                !components
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "Invalid cloud check"
                });
            }

            const overallStatus =
                calculateOverall(components);

            const problemsCount =
                Object.values(components).filter(
                    item => item.status !== "healthy"
                ).length;

            const signature =
                makeSignature(components);

            try {
                await pool.query(
                    `
                    INSERT INTO monitoring_cloud_checks (
                        run_id,
                        checked_at,
                        overall_status,
                        problems_count,
                        components
                    )

                    VALUES ($1, $2, $3, $4, $5::jsonb)

                    ON CONFLICT (run_id)
                    DO NOTHING
                    `,
                    [
                        data.run_id,
                        data.checked_at,
                        overallStatus,
                        problemsCount,
                        JSON.stringify(components)
                    ]
                );

                const stateResult = await pool.query(`
                    SELECT
                        last_signature,
                        last_notified_at,

                        (
                            last_notified_at IS NULL
                            OR last_notified_at <
                                NOW() - INTERVAL '24 hours'
                        ) AS reminder_due

                    FROM monitoring_cloud_alert_state

                    WHERE id = 1
                `);

                const previous = stateResult.rows[0];

                const hasProblems =
                    overallStatus !== "healthy";

                const shouldNotify =
                    previous.last_signature !== signature ||
                    (
                        hasProblems &&
                        previous.reminder_due
                    );

                await pool.query(`
                    DELETE FROM monitoring_cloud_checks
                    WHERE checked_at <
                        NOW() - INTERVAL '90 days'
                `);

                return res.json({
                    ok: true,
                    overall_status: overallStatus,
                    problems_count: problemsCount,
                    signature,
                    should_notify: shouldNotify
                });

            } catch (error) {
                console.error(
                    "Cloud ingest error:",
                    error.code || error.name
                );

                return res.status(503).json({
                    ok: false,
                    error: "Cloud storage unavailable"
                });
            }
        }
    );

    // ======================================
    // CONFIRM TELEGRAM DELIVERY
    // ======================================

    app.post(
        "/api/monitoring/cloud/notification",

        requireCloudSecret,

        async (req, res) => {
            const data = req.body;

            if (
                !data ||
                !validRunId(data.run_id) ||
                typeof data.telegram_message_id !== "string" ||
                !/^\d{1,30}$/.test(data.telegram_message_id)
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "Invalid notification payload"
                });
            }

            let client;

            try {
                client = await pool.connect();

                await client.query("BEGIN");

                const checkResult = await client.query(
                    `
                    SELECT components
                    FROM monitoring_cloud_checks
                    WHERE run_id = $1
                    `,
                    [data.run_id]
                );

                if (!checkResult.rowCount) {
                    await client.query("ROLLBACK");

                    return res.status(404).json({
                        ok: false,
                        error: "Cloud check not found"
                    });
                }

                const signature = makeSignature(
                    checkResult.rows[0].components
                );

                const inserted = await client.query(
                    `
                    INSERT INTO monitoring_cloud_notifications (
                        run_id,
                        signature,
                        telegram_message_id
                    )

                    VALUES ($1, $2, $3)

                    ON CONFLICT (run_id)
                    DO NOTHING

                    RETURNING id
                    `,
                    [
                        data.run_id,
                        signature,
                        data.telegram_message_id
                    ]
                );

                if (inserted.rowCount) {
                    await client.query(
                        `
                        UPDATE monitoring_cloud_alert_state

                        SET
                            last_signature = $1,
                            last_notified_at = NOW(),
                            updated_at = NOW()

                        WHERE id = 1
                        `,
                        [signature]
                    );
                }

                await client.query("COMMIT");

                return res.json({
                    ok: true,
                    inserted: inserted.rowCount === 1
                });

            } catch (error) {
                if (client) {
                    await client.query("ROLLBACK")
                        .catch(() => {});
                }

                console.error(
                    "Cloud notification error:",
                    error.code || error.name
                );

                return res.status(503).json({
                    ok: false,
                    error: "Notification storage unavailable"
                });

            } finally {
                client?.release();
            }
        }
    );

    // ======================================
    // ADMIN DASHBOARD
    // ======================================

    app.get(
        "/api/monitoring/cloud/admin",

        requireAdmin,

        async (req, res) => {
            res.set("Cache-Control", "no-store");

            try {
                const [
                    local,
                    latestResult,
                    historyResult
                ] = await Promise.all([

                    getLocalState(pool),

                    pool.query(`
                        SELECT *
                        FROM monitoring_cloud_checks
                        ORDER BY checked_at DESC, id DESC
                        LIMIT 1
                    `),

                    pool.query(`
                        SELECT
                            run_id,
                            checked_at,
                            overall_status,
                            problems_count

                        FROM monitoring_cloud_checks

                        ORDER BY checked_at DESC, id DESC

                        LIMIT 20
                    `)

                ]);

                const latest =
                    latestResult.rows[0] || null;

                const ageMinutes = latest
                    ? (
                        Date.now() -
                        new Date(latest.checked_at).getTime()
                    ) / 60000
                    : null;

                const watchdogStatus = classifyAge(
                    ageMinutes,
                    45,
                    90
                );

                const externalComponents =
                    latest &&
                    watchdogStatus === "healthy"
                        ? latest.components
                        : {};

                const components = {
                    ...externalComponents,
                    ...local.components
                };

                for (const key of [
                    "website",
                    "backend"
                ]) {
                    if (!components[key]) {
                        components[key] = {
                            status: "unknown",
                            details: "Cloud observation stale or missing"
                        };
                    }
                }

                components.cloud_watchdog = {
                    status: watchdogStatus,

                    details: ageMinutes === null
                        ? "Cloud check not registered"
                        : `Last cloud check: ${
                            ageMinutes.toFixed(1)
                        } min ago`
                };

                return res.json({
                    ok: true,

                    generated_at:
                        new Date().toISOString(),

                    overall_status:
                        calculateOverall(components),

                    problems_count:
                        Object.values(components).filter(
                            item => item.status !== "healthy"
                        ).length,

                    components,

                    last_cloud_check:
                        latest?.checked_at || null,

                    history: historyResult.rows
                });

            } catch (error) {
                console.error(
                    "Cloud admin error:",
                    error.code || error.name
                );

                return res.status(503).json({
                    ok: false,
                    error: "Cloud monitoring unavailable"
                });
            }
        }
    );

    console.log(
        "Cloud monitoring routes registered"
    );
}

module.exports = {
    registerCloudMonitoringRoutes
};