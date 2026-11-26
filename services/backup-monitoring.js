"use strict";

const crypto = require("crypto");

const BACKUP_ID_PATTERN =
    /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-f0-9]{8}$/;

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

function validTimestamp(value) {
    if (typeof value !== "string") {
        return false;
    }

    const timestamp = Date.parse(value);

    if (!Number.isFinite(timestamp)) {
        return false;
    }

    const age = Date.now() - timestamp;

    return age >= -MAX_FUTURE_MS &&
        age <= MAX_AGE_MS;
}

function validDuration(value) {
    return typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 86400;
}

function validBackupId(value) {
    return typeof value === "string" &&
        BACKUP_ID_PATTERN.test(value);
}

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

    if (a.length !== b.length) {
        return false;
    }

    return crypto.timingSafeEqual(a, b);
}

function registerBackupMonitoringRoutes(
    app,
    { pool, requireAdmin }
) {
    if (!pool || !requireAdmin) {
        throw new Error(
            "Backup monitoring dependencies missing"
        );
    }

    function requireBackupSecret(req, res, next) {
        res.set("Cache-Control", "no-store");

        const secret = process.env.BACKUP_INGEST_SECRET;

        if (!secret || secret.length < 32) {
            return res.status(503).json({
                ok: false,
                error: "Backup ingest unavailable"
            });
        }

        if (
            !secureCompare(
                req.get("x-backup-ingest-secret"),
                secret
            )
        ) {
            return res.status(401).json({
                ok: false,
                error: "Unauthorized"
            });
        }

        if (!req.is("application/json")) {
            return res.status(415).json({
                ok: false,
                error: "JSON required"
            });
        }

        next();
    }


    // =====================================
    // BACKUP RESULT INGEST
    // =====================================

    app.post(
        "/api/monitoring/backups/ingest",
        requireBackupSecret,

        async (req, res) => {
            const data = req.body;

            if (
                !data ||
                data.project !== "AURA COFFEE" ||
                !validBackupId(data.backup_id) ||
                !validTimestamp(data.checked_at) ||
                !validDuration(data.duration_seconds) ||
                !["completed", "failed"].includes(
                    data.status
                )
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "Invalid backup payload"
                });
            }

            try {
                const result = await pool.query(
                    `
                    INSERT INTO monitoring_backup_runs (
                        backup_id,
                        status,
                        checked_at,
                        duration_seconds
                    )
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (backup_id)
                    DO NOTHING
                    RETURNING id
                    `,
                    [
                        data.backup_id,
                        data.status,
                        data.checked_at,
                        data.duration_seconds
                    ]
                );

                return res.json({
                    ok: true,
                    inserted: result.rowCount === 1,
                    duplicate: result.rowCount === 0
                });

            } catch (error) {
                console.error(
                    "Backup ingest error:",
                    error.code || error.name
                );

                return res.status(503).json({
                    ok: false,
                    error: "Backup database unavailable"
                });
            }
        }
    );


    // =====================================
    // RESTORE TEST INGEST
    // =====================================

    app.post(
        "/api/monitoring/backups/restore-ingest",
        requireBackupSecret,

        async (req, res) => {
            const data = req.body;

            if (
                !data ||
                data.project !== "AURA COFFEE" ||
                !validBackupId(data.backup_id) ||
                !validTimestamp(data.tested_at) ||
                !validDuration(data.duration_seconds) ||
                !["passed", "failed"].includes(
                    data.status
                ) ||
                !Number.isInteger(
                    data.checked_tables_count
                ) ||
                data.checked_tables_count < 0 ||
                data.checked_tables_count > 10000
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "Invalid restore payload"
                });
            }

            try {
                const result = await pool.query(
                    `
                    INSERT INTO monitoring_restore_tests (
                        backup_id,
                        tested_at,
                        status,
                        duration_seconds,
                        checked_tables_count
                    )
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (backup_id, tested_at)
                    DO NOTHING
                    RETURNING id
                    `,
                    [
                        data.backup_id,
                        data.tested_at,
                        data.status,
                        data.duration_seconds,
                        data.checked_tables_count
                    ]
                );

                return res.json({
                    ok: true,
                    inserted: result.rowCount === 1
                });

            } catch (error) {
                console.error(
                    "Restore ingest error:",
                    error.code || error.name
                );

                return res.status(503).json({
                    ok: false,
                    error: "Restore database unavailable"
                });
            }
        }
    );


    // =====================================
    // ADMIN DASHBOARD API
    // =====================================

    app.get(
        "/api/monitoring/backups/admin",
        requireAdmin,

        async (req, res) => {
            res.set("Cache-Control", "no-store");

            try {
                const [
                    healthResult,
                    historyResult,
                    restoreResult
                ] = await Promise.all([

                    pool.query(`
                        SELECT *
                        FROM monitoring_backup_health
                    `),

                    pool.query(`
                        SELECT
                            backup_id,
                            status,
                            checked_at,
                            duration_seconds
                        FROM monitoring_backup_runs
                        ORDER BY checked_at DESC, id DESC
                        LIMIT 20
                    `),

                    pool.query(`
                        SELECT
                            backup_id,
                            tested_at,
                            status,
                            duration_seconds,
                            checked_tables_count
                        FROM monitoring_restore_tests
                        ORDER BY tested_at DESC, id DESC
                        LIMIT 1
                    `)

                ]);

                const health = healthResult.rows[0];

                const restore =
                    restoreResult.rows[0] || null;

                let restoreHealth = "unknown";

                if (restore) {
                    const ageDays = (
                        Date.now() -
                        new Date(restore.tested_at).getTime()
                    ) / 86400000;

                    if (restore.status === "failed") {
                        restoreHealth = "critical";
                    } else if (ageDays >= 30) {
                        restoreHealth = "warning";
                    } else {
                        restoreHealth = "healthy";
                    }
                }

                return res.json({
                    ok: true,

                    generated_at:
                        new Date().toISOString(),

                    health,

                    history: historyResult.rows,

                    restore,

                    restore_health: restoreHealth,

                    policy: {
                        target_rpo_hours: 24,
                        warning_after_hours: 26,
                        critical_after_hours: 48,
                        restore_interval_days: 30
                    }
                });

            } catch (error) {
                console.error(
                    "Backup dashboard error:",
                    error.code || error.name
                );

                return res.status(503).json({
                    ok: false,
                    error: "Backup monitoring unavailable"
                });
            }
        }
    );

    console.log(
        "Backup monitoring routes registered"
    );
}

module.exports = {
    registerBackupMonitoringRoutes
};