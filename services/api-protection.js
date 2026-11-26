const net = require("node:net");

const RULES = {

    login: {
        scope: "admin_login",
        limit: 10,
        windowSeconds: 900,
        autoBlock: false
    },

    publicWrite: {
        scope: "public_write",
        limit: 20,
        windowSeconds: 60,
        autoBlock: true
    },

    publicRead: {
        scope: "public_read",
        limit: 120,
        windowSeconds: 60,
        autoBlock: true
    }

};


function normalizeIp(value) {

    if (typeof value !== "string") {
        return null;
    }

    let ip = value.trim();

    if (ip.startsWith("::ffff:")) {

        const ipv4 = ip.slice(7);

        if (net.isIP(ipv4) === 4) {
            ip = ipv4;
        }
    }

    return net.isIP(ip)
        ? ip
        : null;
}


function createApiProtection(pool) {

    function getClientIp(req) {

        return normalizeIp(

            req.ip ||

            req.socket?.remoteAddress ||

            ""
        );
    }


    function getRule(req) {

        const path = (
            req.path || "/"
        ).toLowerCase().replace(/\/+$/, "") || "/";

        const method = req.method.toUpperCase();


        if (

            path === "/admin/login" &&

            method === "POST"

        ) {

            return RULES.login;
        }


const excludedPrefixes = [

    "/admin",

    "/api/admin",

    "/api/monitoring",

    "/api/security",

    "/api/protection",

    "/api/ci"
];


        const excluded = excludedPrefixes.some(

            prefix =>

                path === prefix ||

                path.startsWith(prefix + "/")
        );


        if (excluded) {
            return null;
        }


        if (

            path === "/health" ||

            path === "/ready" ||

            method === "OPTIONS"

        ) {

            return null;
        }


        if (!path.startsWith("/api/")) {
            return null;
        }


        if (

            ["POST", "PUT", "PATCH", "DELETE"]
                .includes(method)

        ) {

            return RULES.publicWrite;
        }


        if (["GET", "HEAD"].includes(method)) {

            return RULES.publicRead;
        }

        return null;
    }


    async function middleware(req, res, next) {

        const rule = getRule(req);

        if (!rule) {
            return next();
        }


        const ip = getClientIp(req);

        if (!ip) {

            console.warn(
                "API protection: client IP unavailable"
            );

            return res.status(503).json({

                ok: false,

                error: "Request protection unavailable"
            });
        }


        try {

            const result = await pool.query(

                `
                SELECT *

                FROM consume_security_rate_limit(

                    $1::inet,

                    $2::text,

                    $3::integer,

                    $4::integer,

                    $5::boolean
                )
                `,

                [

                    ip,

                    rule.scope,

                    rule.windowSeconds,

                    rule.limit,

                    rule.autoBlock
                ]
            );


            const state = result.rows[0];


            if (!state) {

                throw new Error(
                    "Rate limit result missing"
                );
            }


            res.set(

                "X-RateLimit-Limit",

                String(rule.limit)
            );


            res.set(

                "X-RateLimit-Remaining",

                String(state.remaining)
            );


            if (!state.allowed) {

                res.set(

                    "Retry-After",

                    String(state.retry_after)
                );


                res.set(

                    "Cache-Control",

                    "no-store"
                );


                if (state.blocked) {

                    return res.status(403).json({

                        ok: false,

                        error: "Temporarily blocked",

                        retry_after:
                            state.retry_after
                    });
                }


                return res.status(429).json({

                    ok: false,

                    error: "Too many requests",

                    retry_after:
                        state.retry_after
                });
            }


            return next();

        } catch (error) {

            console.error(

                "API protection error:",

                error.code || error.name
            );


            // Авторизация и запись защищаются
            // даже при недоступности PostgreSQL.

            if (rule.scope !== "public_read") {

                return res.status(503).json({

                    ok: false,

                    error:
                        "Request protection unavailable"
                });
            }


            // Публичное чтение остаётся доступным.
            return next();
        }
    }


    function requireSameOrigin(req, res, next) {

        const origin = req.get("origin");

        const expectedOrigin =

            `${req.protocol}://${req.get("host")}`;


        if (!origin || origin !== expectedOrigin) {

            return res.status(403).json({

                ok: false,

                error: "Invalid request origin"
            });
        }

        next();
    }


    function registerRoutes(app, requireAdmin) {


        app.get(

            "/api/protection/summary",

            requireAdmin,

            async (req, res) => {

                res.set(
                    "Cache-Control",
                    "no-store"
                );

                try {

                    const result = await pool.query(

                        "SELECT * FROM security_protection_summary"
                    );

                    res.json({

                        ok: true,

                        generated_at:
                            new Date().toISOString(),

                        summary: result.rows[0]
                    });

                } catch (error) {

                    console.error(

                        "Protection summary error:",

                        error.code || error.name
                    );

                    res.status(503).json({

                        ok: false,

                        error:
                            "Protection service unavailable"
                    });
                }
            }
        );


        app.get(

            "/api/protection/blocks",

            requireAdmin,

            async (req, res) => {

                res.set(
                    "Cache-Control",
                    "no-store"
                );

                try {

                    const result = await pool.query(`

                        SELECT *

                        FROM security_active_blocks

                        ORDER BY expires_at DESC

                        LIMIT 200
                    `);


                    res.json({

                        ok: true,

                        blocks: result.rows
                    });

                } catch (error) {

                    console.error(

                        "Protection blocks error:",

                        error.code || error.name
                    );

                    res.status(503).json({

                        ok: false,

                        error:
                            "Protection service unavailable"
                    });
                }
            }
        );


        app.get(

            "/api/protection/events",

            requireAdmin,

            async (req, res) => {

                res.set(
                    "Cache-Control",
                    "no-store"
                );

                try {

                    const result = await pool.query(`

                        SELECT

                            id,

                            event_type,

                            host(ip_address)
                                AS ip_address,

                            scope,

                            created_at

                        FROM security_protection_events

                        ORDER BY created_at DESC, id DESC

                        LIMIT 100
                    `);


                    res.json({

                        ok: true,

                        events: result.rows
                    });

                } catch (error) {

                    console.error(

                        "Protection events error:",

                        error.code || error.name
                    );

                    res.status(503).json({

                        ok: false,

                        error:
                            "Protection service unavailable"
                    });
                }
            }
        );


        app.post(

            "/api/protection/blocks",

            requireAdmin,

            requireSameOrigin,

            async (req, res) => {

                res.set(
                    "Cache-Control",
                    "no-store"
                );


                if (!req.is("application/json")) {

                    return res.status(415).json({

                        ok: false,

                        error: "JSON required"
                    });
                }


                const ip = normalizeIp(

                    req.body?.ip_address
                );


                const minutes =

                    req.body?.duration_minutes;


                const reason =

                    typeof req.body?.reason === "string"

                        ? req.body.reason.trim()

                        : "";


                if (

                    !ip ||

                    !Number.isInteger(minutes) ||

                    minutes < 1 ||

                    minutes > 1440 ||

                    reason.length < 3 ||

                    reason.length > 200

                ) {

                    return res.status(400).json({

                        ok: false,

                        error: "Invalid block parameters"
                    });
                }


                let client;

                try {

                    client = await pool.connect();

                    await client.query("BEGIN");


                    await client.query(

                        `
                        SELECT pg_advisory_xact_lock(

                            hashtextextended(

                                host($1::inet),

                                0
                            )
                        )
                        `,

                        [ip]
                    );


                    const selfCheck =

                        await client.query(

                            `
                            SELECT

                                $1::inet = $2::inet

                                AS is_self
                            `,

                            [ip, getClientIp(req)]
                        );


                    if (

                        !getClientIp(req) ||

                        selfCheck.rows[0].is_self

                    ) {

                        await client.query("ROLLBACK");

                        return res.status(400).json({

                            ok: false,

                            error:
                                "Blocking your own IP is not allowed"
                        });
                    }


                    const existing =

                        await client.query(

                            `
                            SELECT id

                            FROM security_ip_blocks

                            WHERE ip_address = $1::inet

                            AND revoked_at IS NULL

                            AND expires_at > NOW()

                            LIMIT 1
                            `,

                            [ip]
                        );


                    if (existing.rowCount > 0) {

                        await client.query("ROLLBACK");

                        return res.status(409).json({

                            ok: false,

                            error: "IP already blocked"
                        });
                    }


                    const result =

                        await client.query(

                            `
                            INSERT INTO security_ip_blocks (

                                ip_address,

                                block_type,

                                reason,

                                expires_at
                            )

                            VALUES (

                                $1::inet,

                                'manual',

                                $2,

                                NOW() + make_interval(
                                    mins => $3::integer
                                )
                            )

                            RETURNING

                                id,

                                host(ip_address)
                                    AS ip_address,

                                block_type,

                                reason,

                                blocked_at,

                                expires_at
                            `,

                            [ip, reason, minutes]
                        );


                    await client.query(

                        `
                        INSERT INTO security_protection_events (

                            event_type,

                            ip_address,

                            details
                        )

                        VALUES (

                            'manual_block',

                            $1::inet,

                            jsonb_build_object(

                                'block_id',

                                $2::bigint
                            )
                        )
                        `,

                        [ip, result.rows[0].id]
                    );


                    await client.query("COMMIT");


                    res.status(201).json({

                        ok: true,

                        block: result.rows[0]
                    });

                } catch (error) {

                    if (client) {

                        await client.query("ROLLBACK")
                            .catch(() => {});
                    }

                    console.error(

                        "Manual block error:",

                        error.code || error.name
                    );

                    res.status(503).json({

                        ok: false,

                        error:
                            "Protection service unavailable"
                    });

                } finally {

                    client?.release();
                }
            }
        );


        app.post(

            "/api/protection/blocks/:id/revoke",

            requireAdmin,

            requireSameOrigin,

            async (req, res) => {

                res.set(
                    "Cache-Control",
                    "no-store"
                );


                const id = req.params.id;


                if (

                    !/^[1-9]\d{0,18}$/.test(id) ||

                    BigInt(id) >
                        9223372036854775807n

                ) {

                    return res.status(400).json({

                        ok: false,

                        error: "Invalid block ID"
                    });
                }


                try {

                    const result = await pool.query(

                        `
                        WITH revoked AS (

                            UPDATE security_ip_blocks

                            SET revoked_at = NOW()

                            WHERE id = $1::bigint

                            AND revoked_at IS NULL

                            AND expires_at > NOW()

                            RETURNING

                                id,

                                ip_address
                        )

                        INSERT INTO security_protection_events (

                            event_type,

                            ip_address,

                            details
                        )

                        SELECT

                            'manual_unblock',

                            ip_address,

                            jsonb_build_object(

                                'block_id',

                                id
                            )

                        FROM revoked

                        RETURNING id
                        `,

                        [id]
                    );


                    if (!result.rowCount) {

                        return res.status(404).json({

                            ok: false,

                            error: "Active block not found"
                        });
                    }


                    res.json({

                        ok: true,

                        revoked: true
                    });

                } catch (error) {

                    console.error(

                        "Block revoke error:",

                        error.code || error.name
                    );

                    res.status(503).json({

                        ok: false,

                        error:
                            "Protection service unavailable"
                    });
                }
            }
        );
    }


    return {

        middleware,

        registerRoutes
    };
}


module.exports = {

    createApiProtection
};