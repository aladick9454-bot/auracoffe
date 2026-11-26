const ALLOWED_PERIODS = {
    "24h": 24,
    "7d": 168,
    "30d": 720
};

function createSecurityMonitoring(pool) {

    async function saveEvent(event) {

        await pool.query(
            `
            INSERT INTO security_events (
                event_type,
                severity,
                ip_address,
                user_agent,
                request_method,
                request_path,
                status_code,
                details
            )
            VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8::jsonb
            )
            `,
            [
                event.event_type,
                event.severity,
                event.ip_address || null,
                event.user_agent || null,
                event.request_method || null,
                event.request_path || null,
                event.status_code || null,
                JSON.stringify(event.details || {})
            ]
        );
    }


    function getSafeRequestPath(req) {

        const path = req.path || "/";

        return path
            .replace(
                /\/[a-f0-9]{32,}/gi,
                "/[redacted]"
            )
            .slice(0, 300);
    }


    function middleware(req, res, next) {

        const startedAt = Date.now();

        const requestPath = getSafeRequestPath(req);

        const method = req.method;

        const ipAddress = String(
            req.ip ||
            req.socket?.remoteAddress ||
            "unknown"
        ).slice(0, 100);

        const userAgent = String(
            req.get("user-agent") || ""
        ).slice(0, 300);

        res.once("finish", () => {

            const statusCode = res.statusCode;

            const isAdminPath =
                requestPath === "/admin" ||
                requestPath.startsWith("/admin/");

            const isMonitoringApi =
                requestPath.startsWith(
                    "/api/monitoring/"
                );

            const isSecurityApi =
                requestPath.startsWith(
                    "/api/security/"
                );

            const isLogin =
                requestPath === "/admin/login" &&
                method === "POST";

            const isMutation =
                ["POST", "PUT", "PATCH", "DELETE"]
                    .includes(method);

            let eventType = null;
            let severity = "info";

            if (
                isLogin &&
                [401, 403, 429].includes(statusCode)
            ) {

                eventType = "login_failed";
                severity = "warning";

            } else if (
                statusCode === 401 ||
                statusCode === 403
            ) {

                eventType = "unauthorized_access";
                severity = "warning";

            } else if (statusCode === 429) {

                eventType = "rate_limit_exceeded";
                severity = "warning";

            } else if (
                statusCode >= 500 &&
                (
                    isAdminPath ||
                    isMonitoringApi ||
                    isSecurityApi
                )
            ) {

                eventType = "server_error";
                severity = "critical";

            } else if (
                !isLogin &&
                isMutation &&
                (
                    isAdminPath ||
                    isMonitoringApi ||
                    isSecurityApi
                ) &&
                statusCode >= 200 &&
                statusCode < 300
            ) {

                eventType = isAdminPath ||
                    req.path.includes("/acknowledge")
                    ? "admin_action"
                    : "protected_api_write";
            }

            if (!eventType) {
                return;
            }

            saveEvent({
                event_type: eventType,
                severity,
                ip_address: ipAddress,
                user_agent: userAgent,
                request_method: method,
                request_path: requestPath,
                status_code: statusCode,
                details: {
                    duration_ms:
                        Date.now() - startedAt
                }
            }).catch(error => {

                console.error(
                    "Security event save error:",
                    error.message
                );

            });
        });

        next();
    }


    function recordLogin(req, success) {

        return saveEvent({
            event_type: success
                ? "login_success"
                : "login_failed",

            severity: success
                ? "info"
                : "warning",

            ip_address: String(
                req.ip ||
                req.socket?.remoteAddress ||
                "unknown"
            ).slice(0, 100),

            user_agent: String(
                req.get("user-agent") || ""
            ).slice(0, 300),

            request_method: req.method,

            request_path: "/admin/login",

            details: {
                authentication_success: success
            }
        });
    }


    function registerRoutes(app, requireAdmin) {

        app.get(
            "/api/security/summary",
            requireAdmin,
            async (req, res) => {

                res.set("Cache-Control", "no-store");

                try {

                    const summary = await pool.query(
                        "SELECT * FROM security_summary"
                    );

                    const alerts = await pool.query(`
                        SELECT
                            COUNT(*) AS total_alerts,

                            COUNT(*) FILTER (
                                WHERE notification_status =
                                    'sent'
                            ) AS sent_alerts,

                            COUNT(*) FILTER (
                                WHERE notification_status IN (
                                    'pending',
                                    'processing',
                                    'failed'
                                )
                            ) AS pending_alerts,

                            COUNT(*) FILTER (
                                WHERE notification_status =
                                    'dead'
                            ) AS dead_alerts

                        FROM security_alerts

                        WHERE created_at >= NOW()
                            - INTERVAL '24 hours'
                    `);

                    res.json({
                        ok: true,
                        generated_at:
                            new Date().toISOString(),

                        summary: {
                            ...summary.rows[0],
                            ...alerts.rows[0]
                        }
                    });

                } catch (error) {

                    console.error(
                        "Security summary error:",
                        error.message
                    );

                    res.status(503).json({
                        ok: false,
                        error:
                            "Security service unavailable"
                    });
                }
            }
        );


        app.get(
            "/api/security/events",
            requireAdmin,
            async (req, res) => {

                res.set("Cache-Control", "no-store");

                const period = req.query.period || "24h";

                const severity =
                    req.query.severity || "all";

                const limit = Number(
                    req.query.limit || 25
                );

                const offset = Number(
                    req.query.offset || 0
                );

                if (
                    !Object.hasOwn(
                        ALLOWED_PERIODS,
                        period
                    ) ||

                    ![
                        "all",
                        "info",
                        "warning",
                        "critical"
                    ].includes(severity) ||

                    !Number.isSafeInteger(limit) ||
                    limit < 1 ||
                    limit > 100 ||

                    !Number.isSafeInteger(offset) ||
                    offset < 0 ||
                    offset > 100000
                ) {

                    return res.status(400).json({
                        ok: false,
                        error: "Invalid query parameters"
                    });
                }

                try {

                    const hours =
                        ALLOWED_PERIODS[period];

                    const result = await pool.query(
                        `
                        SELECT
                            id,
                            event_type,
                            severity,
                            ip_address,
                            request_method,
                            request_path,
                            status_code,
                            created_at

                        FROM security_events

                        WHERE created_at >= NOW()
                            - make_interval(
                                hours => $1::integer
                            )

                        AND (
                            $2::text = 'all'
                            OR severity = $2::text
                        )

                        ORDER BY
                            created_at DESC,
                            id DESC

                        LIMIT $3 OFFSET $4
                        `,
                        [
                            hours,
                            severity,
                            limit,
                            offset
                        ]
                    );

                    const count = await pool.query(
                        `
                        SELECT COUNT(*) AS total

                        FROM security_events

                        WHERE created_at >= NOW()
                            - make_interval(
                                hours => $1::integer
                            )

                        AND (
                            $2::text = 'all'
                            OR severity = $2::text
                        )
                        `,
                        [hours, severity]
                    );

                    res.json({
                        ok: true,
                        period,
                        severity,
                        limit,
                        offset,

                        total: Number(
                            count.rows[0].total
                        ),

                        events: result.rows
                    });

                } catch (error) {

                    console.error(
                        "Security events error:",
                        error.message
                    );

                    res.status(503).json({
                        ok: false,
                        error:
                            "Security service unavailable"
                    });
                }
            }
        );


        app.get(
            "/api/security/alerts",
            requireAdmin,
            async (req, res) => {

                res.set("Cache-Control", "no-store");

                try {

                    const result = await pool.query(`
                        SELECT
                            id,
                            alert_type,
                            severity,
                            ip_address,
                            event_count,
                            notification_status,
                            attempt_count,
                            created_at,
                            notified_at

                        FROM security_alerts

                        ORDER BY
                            created_at DESC,
                            id DESC

                        LIMIT 50
                    `);

                    res.json({
                        ok: true,
                        alerts: result.rows
                    });

                } catch (error) {

                    console.error(
                        "Security alerts error:",
                        error.message
                    );

                    res.status(503).json({
                        ok: false,
                        error:
                            "Security service unavailable"
                    });
                }
            }
        );
    }


    return {
        middleware,
        saveEvent,
        recordLogin,
        registerRoutes
    };
}

module.exports = {
    createSecurityMonitoring
};