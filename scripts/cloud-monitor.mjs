// ==========================================
// AURA COFFEE
// INDEPENDENT CLOUD MONITOR
// ==========================================

const BASE_URL =
    "https://aura-coffee-api-2lty.onrender.com";

const WEBSITE_URL =
    "https://aladick9454-bot.github.io/auracoffe/";

const CLOUD_SECRET =
    process.env.CLOUD_MONITOR_SECRET;

const TELEGRAM_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
    process.env.TELEGRAM_CHAT_ID;

const RUN_ID = [
    process.env.GITHUB_RUN_ID,
    process.env.GITHUB_RUN_ATTEMPT
].join("-");

const TIMEOUT_MS = 90000;

const componentNames = {
    local_n8n: "Локальный n8n",
    website: "Сайт",
    backend: "Backend",
    database: "PostgreSQL",
    central_monitoring: "Центральный мониторинг",
    backup_system: "Резервное копирование"
};

const statusIcons = {
    healthy: "✅",
    warning: "⚠️",
    critical: "🚨",
    unknown: "❔"
};

function validateEnvironment() {
    if (
        !CLOUD_SECRET ||
        CLOUD_SECRET.length < 32 ||
        !TELEGRAM_TOKEN ||
        !TELEGRAM_CHAT_ID
    ) {
        throw new Error(
            "Required environment secrets missing"
        );
    }

    if (!/^\d+-\d+$/.test(RUN_ID)) {
        throw new Error("Invalid GitHub run ID");
    }
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

async function request(
    url,
    options = {},
    timeoutMs = TIMEOUT_MS
) {
    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        timeoutMs
    );

    try {
        const response = await fetch(url, {
            ...options,
            redirect: "error",
            signal: controller.signal
        });

        return await (async () => {
            const text = await response.text();

            let data = null;

            try {
                data = JSON.parse(text);
            } catch {
                // HTML response or empty body
            }

            return {
                ok: response.ok,
                status: response.status,
                data,
                text
            };
        })();

    } finally {
        clearTimeout(timeout);
    }
}

async function probe(
    url,
    requireJson = false
) {
    let lastResult;

    for (let attempt = 1; attempt <= 2; attempt++) {
        const startedAt = Date.now();

        try {
            const result = await request(url);

            const duration =
                Date.now() - startedAt;

            if (
                result.ok &&
                (
                    !requireJson ||
                    (
                        result.data &&
                        result.data.ok !== false
                    )
                )
            ) {
                return {
                    status: "healthy",

                    details: `HTTP ${
                        result.status
                    }; ${duration} ms`
                };
            }

            lastResult = {
                status: "critical",
                details: `HTTP ${result.status}; unexpected response`
            };

        } catch {
            lastResult = {
                status: "critical",
                details: "Connection failed or timeout"
            };
        }

        if (attempt < 2) {
            await sleep(5000);
        }
    }

    return lastResult;
}

async function cloudApi(path, body) {
    const options = {
        method: body ? "POST" : "GET",

        headers: {
            "x-cloud-monitor-secret": CLOUD_SECRET,
            "Content-Type": "application/json"
        }
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await request(
        BASE_URL + path,
        options
    );

    if (
        !response.ok ||
        !response.data?.ok
    ) {
        throw new Error(
            `Cloud API error: HTTP ${response.status}`
        );
    }

    return response.data;
}

async function sendTelegram(message) {
    const url =
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

    const response = await request(
        url,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                disable_web_page_preview: true
            })
        },
        20000
    );

    if (
        !response.ok ||
        response.data?.ok !== true ||
        response.data?.result?.message_id === undefined
    ) {
        throw new Error(
            `Telegram delivery failed: HTTP ${response.status}`
        );
    }

    return String(response.data.result.message_id);
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

function buildMessage(
    components,
    overallStatus,
    fallback = false
) {
    const title = overallStatus === "healthy"
        ? "CLOUD MONITORING: СИСТЕМА В НОРМЕ"
        : "CLOUD MONITORING: ОБНАРУЖЕНЫ ПРОБЛЕМЫ";

    const lines = [
        `${statusIcons[overallStatus]} ${title}`,

        "",

        "AURA COFFEE — Independent Watchdog",

        `Общий статус: ${overallStatus.toUpperCase()}`,

        "",

        ...Object.entries(components).flatMap(
            ([key, value]) => [
                `${statusIcons[value.status]} ${
                    componentNames[key] || key
                }: ${value.status.toUpperCase()}`,

                value.details,

                ""
            ]
        ),

        `Проверено: ${
            new Date().toLocaleString("ru-RU", {
                timeZone: "Asia/Novosibirsk"
            })
        }`,

        `GitHub Run: ${RUN_ID}`,

        "",

        fallback
            ? "Аварийный режим: журнал Backend недоступен. Возможны повторные уведомления."
            : "Результаты сохранены в системе мониторинга.",

        "",

        "Панель мониторинга:",

        `${BASE_URL}/admin/monitoring`
    ];

    return lines.join("\n");
}

async function main() {
    validateEnvironment();

    console.log("Starting independent cloud check");

    // ======================================
    // EXTERNAL AVAILABILITY CHECKS
    // ======================================

    const [
        website,
        backend,
        databaseReadiness
    ] = await Promise.all([

        probe(WEBSITE_URL),

        probe(`${BASE_URL}/health`, true),

        probe(`${BASE_URL}/ready`, true)

    ]);

    const components = {
        website,

        backend,

        database: databaseReadiness.status === "healthy"
            ? {
                status: "healthy",
                details: "Database readiness check passed"
            }
            : {
                status: backend.status === "healthy"
                    ? "critical"
                    : "unknown",

                details: "Database readiness unavailable"
            },

        local_n8n: {
            status: "unknown",
            details: "Heartbeat state unavailable"
        },

        central_monitoring: {
            status: "unknown",
            details: "Central state unavailable"
        },

        backup_system: {
            status: "unknown",
            details: "Backup state unavailable"
        }
    };

    // ======================================
    // LOAD INTERNAL MONITORING STATE
    // ======================================

    let stateAvailable = false;

    try {
        const state = await cloudApi(
            "/api/monitoring/cloud/state"
        );

        if (state.components) {
            for (const key of [
                "local_n8n",
                "central_monitoring",
                "backup_system"
            ]) {
                if (state.components[key]) {
                    components[key] =
                        state.components[key];
                }
            }

            if (
                state.components.database?.status === "healthy"
            ) {
                components.database =
                    state.components.database;
            }

            stateAvailable = true;
        }

    } catch {
        console.error(
            "Internal monitoring state unavailable"
        );
    }

    const overallStatus =
        calculateOverall(components);

    console.log(
        "Cloud component statuses:",
        JSON.stringify(
            Object.fromEntries(
                Object.entries(components).map(
                    ([key, item]) => [key, item.status]
                )
            )
        )
    );

    // ======================================
    // SAVE CLOUD CHECK
    // ======================================

    let result;

    try {
        result = await cloudApi(
            "/api/monitoring/cloud/ingest",
            {
                run_id: RUN_ID,

                checked_at:
                    new Date().toISOString(),

                components
            }
        );

    } catch {
        console.error(
            "Cloud storage unavailable; fallback mode"
        );

        await sendTelegram(
            buildMessage(
                components,
                overallStatus === "healthy"
                    ? "warning"
                    : overallStatus,
                true
            )
        );

        console.log(
            "Fallback Telegram notification delivered"
        );

        throw new Error(
            "Cloud check could not be persisted"
        );
    }

    console.log(
        "Cloud check saved:",
        result.overall_status
    );

    // ======================================
    // STATE-BASED TELEGRAM ALERT
    // ======================================

    if (result.should_notify === true) {
        const message = buildMessage(
            components,
            result.overall_status
        );

        const messageId =
            await sendTelegram(message);

        await cloudApi(
            "/api/monitoring/cloud/notification",
            {
                run_id: RUN_ID,

                telegram_message_id:
                    messageId
            }
        );

        console.log(
            "Telegram notification sent and registered"
        );

    } else {
        console.log(
            "Notification skipped: status unchanged"
        );
    }

    // ======================================
    // FINAL EXECUTION RESULT
    // ======================================

    if (!stateAvailable) {
        throw new Error(
            "Internal state could not be verified"
        );
    }

    console.log(
        `CLOUD MONITORING COMPLETED: ${
            result.overall_status.toUpperCase()
        }`
    );
}

main().catch(() => {
    console.error(
        "Cloud monitoring execution failed; inspect status logs"
    );

    process.exitCode = 1;
});