"use strict";

const { Client } = require("pg");

const { spawnSync } = require("node:child_process");

const {

    validateVersion,

    validateConfirmation,

    isValidCommit

} = require("./release-preflight.cjs");


const BASE_URL =
    "https://aura-coffee-api-2lty.onrender.com";

const API_URL =
    "https://api.render.com/v1";

const POLL_INTERVAL = 15000;

const DEPLOY_TIMEOUT = 15 * 60 * 1000;

const RELEASE_LOCK = "81009001";


const FAILURE_STATUSES = new Set([

    "build_failed",

    "update_failed",

    "pre_deploy_failed",

    "canceled",

    "deactivated"
]);


const ACTIVE_STATUSES = new Set([

    "created",

    "queued",

    "build_in_progress",

    "update_in_progress",

    "pre_deploy_in_progress"
]);


const sleep = ms =>

    new Promise(resolve => setTimeout(resolve, ms));


function validateConfig() {

    const required = [

        "PRODUCTION_DATABASE_URL",

        "RENDER_API_KEY",

        "RENDER_SERVICE_ID",

        "RELEASE_VERSION",

        "RELEASE_CONFIRMATION",

        "GITHUB_SHA",

        "GITHUB_RUN_ID",

        "GITHUB_RUN_ATTEMPT"
    ];


    for (const key of required) {

        if (!process.env[key]) {

            throw new Error(
                `Missing environment variable: ${key}`
            );
        }
    }


    if (!validateConfirmation(
        process.env.RELEASE_CONFIRMATION
    )) {

        throw new Error(
            "Production release confirmation required"
        );
    }


    if (!validateVersion(
        process.env.RELEASE_VERSION
    )) {

        throw new Error("Invalid release version");
    }


    if (!isValidCommit(process.env.GITHUB_SHA)) {

        throw new Error("Invalid commit SHA");
    }


    if (process.env.GITHUB_REF !== "refs/heads/main") {

        throw new Error("Main branch required");
    }
}


async function renderRequest(
    path,
    method = "GET",
    body
) {

    const response = await fetch(

        `${API_URL}${path}`,

        {

            method,

            redirect: "error",

            headers: {

                Authorization:
                    `Bearer ${process.env.RENDER_API_KEY}`,

                Accept: "application/json",

                "Content-Type": "application/json"
            },

            body:

                body === undefined

                    ? undefined

                    : JSON.stringify(body),

            signal: AbortSignal.timeout(30000)
        }
    );


    if (!response.ok) {

        throw new Error(
            `Render API HTTP ${response.status}`
        );
    }


    return response.json();
}


function servicePath() {

    return "/services/" +

        encodeURIComponent(
            process.env.RENDER_SERVICE_ID
        );
}


async function listDeploys() {

    const result = await renderRequest(

        `${servicePath()}/deploys?limit=20`
    );


    if (!Array.isArray(result)) {

        throw new Error(
            "Unexpected Render deploy list"
        );
    }


    return result.map(

        item => item.deploy || item
    );
}


async function getDeploy(deployId) {

    return renderRequest(

        `${servicePath()}/deploys/` +

        encodeURIComponent(deployId)
    );
}


async function getLiveDeploy() {

    const deploys = await listDeploys();


    if (deploys.some(

        deploy => ACTIVE_STATUSES.has(deploy.status)

    )) {

        throw new Error(
            "Another Render deployment is in progress"
        );
    }


    const live = deploys.find(
        deploy => deploy.status === "live"
    );


    if (!live || !live.id || !live.commit?.id) {

        throw new Error(
            "No rollback candidate found"
        );
    }


    return live;
}


async function verifyRenderConfiguration() {

    const result = await renderRequest(
        servicePath()
    );


    const service = result.service || result;


    if (

        service.autoDeployTrigger !== undefined

            ? service.autoDeployTrigger !== "off"

            : service.autoDeploy !== "no"

    ) {

        throw new Error(
            "Render Auto-Deploy must be disabled"
        );
    }


    if (service.branch !== "main") {

        throw new Error(
            "Render service branch must be main"
        );
    }
}


async function waitForDeploy(deployId) {

    const deadline = Date.now() + DEPLOY_TIMEOUT;


    while (Date.now() < deadline) {

        const deploy = await getDeploy(deployId);


        console.log(

            "Render deployment status:",

            deploy.status
        );


        if (deploy.status === "live") {

            return deploy;
        }


        if (FAILURE_STATUSES.has(deploy.status)) {

            throw new Error(
                `Render deployment failed: ${deploy.status}`
            );
        }


        await sleep(POLL_INTERVAL);
    }


    throw new Error("Render deployment timeout");
}


async function requestDeploy(commit) {

    const result = await renderRequest(

        `${servicePath()}/deploys`,

        "POST",

        {

            commitId: commit,

            clearCache: "do_not_clear"
        }
    );


    if (!result.id) {

        throw new Error(
            "Render deploy ID missing"
        );
    }


    return result.id;
}


async function requestRollback(deployId) {

    const result = await renderRequest(

        `${servicePath()}/rollback`,

        "POST",

        { deployId }
    );


    if (!result.id) {

        throw new Error(
            "Render rollback ID missing"
        );
    }


    return result.id;
}


async function probeHealth(path) {

    for (let attempt = 1; attempt <= 4; attempt++) {

        try {

            const response = await fetch(

                `${BASE_URL}${path}`,

                {

                    cache: "no-store",

                    redirect: "error",

                    signal: AbortSignal.timeout(90000)
                }
            );


            if (response.ok) {

                const data = await response.json();


                if (

                    data &&

                    typeof data === "object" &&

                    data.ok !== false &&

                    data.status !== "error"

                ) {

                    console.log(`${path}: PASSED`);

                    return;
                }
            }

        } catch {

            console.log(
                `${path}: retry ${attempt}`
            );
        }


        if (attempt < 4) {

            await sleep(10000);
        }
    }


    throw new Error(
        `Health check failed: ${path}`
    );
}


function runSmokeTests() {

    const result = spawnSync(

        process.execPath,

        [

            "--test",

            "tests/smoke.test.cjs"
        ],

        {

            stdio: "inherit",

            timeout: 240000,

            env: {

                PATH: process.env.PATH,

                NODE_ENV: "test",

                BASE_URL,

                PRODUCTION_BASE_URL: BASE_URL
            }
        }
    );


    if (

        result.error ||

        result.signal ||

        result.status !== 0

    ) {

        throw new Error(
            "Production smoke tests failed"
        );
    }


    console.log("PRODUCTION SMOKE TESTS PASSED");
}


async function notifyTelegram(message) {

    const token = process.env.TELEGRAM_BOT_TOKEN;

    const chatId = process.env.TELEGRAM_CHAT_ID;


    if (!token || !chatId) {

        console.warn(
            "Telegram configuration unavailable"
        );

        return;
    }


    try {

        const response = await fetch(

            `https://api.telegram.org/bot${token}/sendMessage`,

            {

                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({

                    chat_id: chatId,

                    text: message,

                    disable_web_page_preview: true
                }),

                signal: AbortSignal.timeout(20000)
            }
        );


        const data = await response.json();


        if (!response.ok || !data.ok) {

            throw new Error("Telegram rejected message");
        }


        console.log("TELEGRAM NOTIFICATION SENT");

    } catch {

        console.warn(
            "Telegram notification failed"
        );
    }
}


async function recordEvent(
    client,
    releaseId,
    type,
    message
) {

    await client.query(

        `INSERT INTO public.application_release_events (

            release_id,

            event_type,

            message

        ) VALUES ($1, $2, $3)`,

        [

            releaseId,

            type,

            String(message).slice(0, 500)
        ]
    );


    console.log(`[${type}] ${message}`);
}


async function setStatus(
    client,
    releaseId,
    status
) {

    await client.query(

        `UPDATE public.application_releases

         SET status = $2,

             updated_at = NOW()

         WHERE id = $1`,

        [releaseId, status]
    );
}


async function finishRelease(

    client,

    releaseId,

    status,

    startedAt,

    smokePassed,

    errorMessage = null

) {

    await client.query(

        `UPDATE public.application_releases

         SET status = $2,

             duration_ms = $3,

             smoke_passed = $4,

             error_message = $5,

             finished_at = NOW(),

             updated_at = NOW()

         WHERE id = $1`,

        [

            releaseId,

            status,

            Date.now() - startedAt,

            smokePassed,

            errorMessage
        ]
    );
}


function safeError(error) {

    let message = String(

        error?.message || "Unknown release error"
    );


    for (const key of [

        "RENDER_API_KEY",

        "PRODUCTION_DATABASE_URL",

        "TELEGRAM_BOT_TOKEN"

    ]) {

        const secret = process.env[key];


        if (secret) {

            message = message.replaceAll(
                secret,
                "[REDACTED]"
            );
        }
    }


    return message.slice(0, 500);
}


async function main() {

    validateConfig();


    const startedAt = Date.now();


    const runId = [

        process.env.GITHUB_RUN_ID,

        process.env.GITHUB_RUN_ATTEMPT

    ].join("-");


    const version = process.env.RELEASE_VERSION;

    const commit = process.env.GITHUB_SHA;


    const client = new Client({

        connectionString:
            process.env.PRODUCTION_DATABASE_URL,

        connectionTimeoutMillis: 15000,

        query_timeout: 30000
    });


    let locked = false;

    let releaseId = null;

    let previousDeploy = null;

    let deployId = null;

    let deployRequested = false;


    await client.connect();


    try {

        const lock = await client.query(

            `SELECT pg_try_advisory_lock(
                $1::bigint
            ) AS acquired`,

            [RELEASE_LOCK]
        );


        locked = lock.rows[0].acquired;


        if (!locked) {

            throw new Error(
                "Another production release is running"
            );
        }


        const unfinished = await client.query(`

            SELECT id

            FROM public.application_releases

            WHERE status IN (

                'pending',

                'deploying',

                'verifying',

                'rolling_back'
            )

            LIMIT 1
        `);


        if (unfinished.rows.length) {

            throw new Error(
                "An unfinished release requires investigation"
            );
        }


        await verifyRenderConfiguration();


        previousDeploy = await getLiveDeploy();


        const migrations = await client.query(`

            SELECT MAX(version) AS version

            FROM public.schema_migrations
        `);


        const result = await client.query(

            `INSERT INTO public.application_releases (

                run_id,

                release_version,

                commit_sha,

                previous_commit_sha,

                previous_deploy_id,

                migration_version,

                status

            )

            VALUES (

                $1, $2, $3, $4, $5, $6, 'pending'

            )

            RETURNING id`,

            [

                runId,

                version,

                commit,

                previousDeploy.commit.id,

                previousDeploy.id,

                migrations.rows[0].version
            ]
        );


        releaseId = result.rows[0].id;


        await recordEvent(

            client,

            releaseId,

            "release_started",

            `Release ${version} started`
        );


        await setStatus(
            client,
            releaseId,
            "deploying"
        );


        deployRequested = true;


        deployId = await requestDeploy(commit);


        await client.query(

            `UPDATE public.application_releases

             SET render_deploy_id = $2,

                 updated_at = NOW()

             WHERE id = $1`,

            [releaseId, deployId]
        );


        await recordEvent(

            client,

            releaseId,

            "deployment_requested",

            "Render deployment requested"
        );


        const deployment = await waitForDeploy(
            deployId
        );


        if (deployment.commit?.id !== commit) {

            throw new Error(
                "Deployed commit does not match expected SHA"
            );
        }


        await setStatus(
            client,
            releaseId,
            "verifying"
        );


        await probeHealth("/health");

        await probeHealth("/ready");


        runSmokeTests();


        const live = await getLiveDeploy();


        if (

            live.id !== deployId ||

            live.commit?.id !== commit

        ) {

            throw new Error(
                "Live deployment changed during verification"
            );
        }


        await recordEvent(

            client,

            releaseId,

            "verification_passed",

            "Health checks and smoke tests passed"
        );


        await finishRelease(

            client,

            releaseId,

            "success",

            startedAt,

            true
        );


        await notifyTelegram(

            "SUCCESS: AURA COFFEE RELEASE\n\n" +

            `Version: ${version}\n` +

            `Commit: ${commit.slice(0, 12)}\n` +

            "Health checks: PASSED\n" +

            "Database readiness: PASSED\n" +

            "Smoke tests: PASSED\n\n" +

            BASE_URL
        );


        console.log("PRODUCTION RELEASE COMPLETED");

    } catch (error) {

        const message = safeError(error);


        console.error("RELEASE FAILED:", message);


        if (releaseId) {

            let finalStatus = "failed";


            try {

                await recordEvent(

                    client,

                    releaseId,

                    "release_failed",

                    message
                );


                if (deployId && previousDeploy) {

                    const deploy = await getDeploy(
                        deployId
                    );


                    const live = await getLiveDeploy();


                    if (

                        deploy.status === "live" &&

                        live.id === deployId

                    ) {

                        await setStatus(

                            client,

                            releaseId,

                            "rolling_back"
                        );


                        const rollbackId =

                            await requestRollback(

                                previousDeploy.id
                            );


                        await client.query(

                            `UPDATE public.application_releases

                             SET rollback_deploy_id = $2

                             WHERE id = $1`,

                            [releaseId, rollbackId]
                        );


                        const rollback =

                            await waitForDeploy(
                                rollbackId
                            );


                        if (

                            rollback.commit?.id !==

                            previousDeploy.commit.id

                        ) {

                            throw new Error(
                                "Rollback commit mismatch"
                            );
                        }


                        await probeHealth("/health");

                        await probeHealth("/ready");

                        runSmokeTests();


                        finalStatus = "rolled_back";


                        await recordEvent(

                            client,

                            releaseId,

                            "rollback_completed",

                            "Previous application version restored"
                        );

                    } else if (

                        live.id === previousDeploy.id

                    ) {

                        await recordEvent(

                            client,

                            releaseId,

                            "rollback_not_required",

                            "Previous deployment remains live"
                        );

                    } else {

                        throw new Error(
                            "Unexpected live deployment; manual inspection required"
                        );
                    }

                } else if (deployRequested) {

                    throw new Error(
                        "Deployment request outcome unknown; manual inspection required"
                    );
                }

            } catch (rollbackError) {

                finalStatus = "rollback_failed";


                console.error(

                    "ROLLBACK REQUIRES ATTENTION:",

                    safeError(rollbackError)
                );
            }


            await finishRelease(

                client,

                releaseId,

                finalStatus,

                startedAt,

                null,

                message
            );


            await notifyTelegram(

                "ALERT: AURA COFFEE RELEASE\n\n" +

                `Version: ${version}\n` +

                `Status: ${finalStatus}\n` +

                `Run: ${runId}\n\n` +

                "Check GitHub Actions and Render Dashboard."
            );

        } else {

            await notifyTelegram(

                "ALERT: Production release could not start.\n" +

                `Version: ${version}\n` +

                "Check GitHub Actions logs."
            );
        }


        throw error;

    } finally {

        try {

            if (locked) {

                await client.query(

                    "SELECT pg_advisory_unlock($1::bigint)",

                    [RELEASE_LOCK]
                );
            }

        } finally {

            await client.end();
        }
    }
}


if (require.main === module) {

    main().catch(error => {

        console.error(

            "RELEASE MANAGER FAILED:",

            safeError(error)
        );


        process.exitCode = 1;
    });
}


module.exports = {

    FAILURE_STATUSES,

    ACTIVE_STATUSES,

    safeError
};