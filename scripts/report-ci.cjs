const BASE_URL =

    "https://aura-coffee-api-2lty.onrender.com";


const secret =

    process.env.CI_MONITOR_SECRET;


const token =

    process.env.TELEGRAM_BOT_TOKEN;


const chatId =

    process.env.TELEGRAM_CHAT_ID;


async function main() {

    const runId = process.env.GITHUB_RUN_ID;

    const attempt = process.env.GITHUB_RUN_ATTEMPT;


    const status = process.env.CI_STATUS;

    const workflow = process.env.CI_WORKFLOW;


    if (

        !runId ||

        !attempt ||

        !["success", "failure", "cancelled"]

            .includes(status) ||

        !["ci", "production-smoke"]

            .includes(workflow)

    ) {

        throw new Error("Invalid CI environment");
    }


    const start = Number(

        process.env.CI_STARTED_AT
    );


    const duration = Number.isFinite(start)

        ? Math.max(

            0,

            Math.round(Date.now() / 1000 - start)

        )

        : 0;


    const payload = {

        run_id: `${runId}-${attempt}`,

        workflow_name: workflow,

        commit_sha: process.env.GITHUB_SHA,

        branch_name: process.env.GITHUB_REF_NAME,

        status,

        duration_seconds: duration,

        run_url:

            "https://github.com/" +

            process.env.GITHUB_REPOSITORY +

            "/actions/runs/" +

            runId
    };


    let reportSaved = false;


    if (secret && secret.length >= 32) {

        try {

            const response = await fetch(

                `${BASE_URL}/api/ci/ingest`,

                {

                    method: "POST",

                    headers: {

                        "Content-Type": "application/json",

                        "x-ci-monitor-secret": secret
                    },

                    body: JSON.stringify(payload),

                    signal: AbortSignal.timeout(90000)
                }
            );


            const data = await response.json();


            if (!response.ok || !data.ok) {

                throw new Error(

                    `CI report HTTP ${response.status}`
                );
            }


            reportSaved = true;


            console.log(

                "CI report saved:",

                payload.run_id
            );

        } catch {

            console.error("CI report delivery failed");
        }

    } else {

        console.error("CI_MONITOR_SECRET is missing");
    }


    if (status === "failure") {

        if (!token || !chatId) {

            console.error("Telegram secrets missing");

            process.exitCode = 1;

            return;
        }


        const message = [

            "🔴 AURA COFFEE — CI FAILURE",

            "",

            `Workflow: ${workflow}`,

            `Branch: ${payload.branch_name}`,

            `Commit: ${payload.commit_sha?.slice(0, 8)}`,

            `Duration: ${duration} sec`,

            `Database report: ${reportSaved ? "saved" : "unavailable"}`,

            "",

            payload.run_url

        ].join("\n");


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

                throw new Error("Telegram delivery failed");
            }


            console.log("CI failure notification sent");

        } catch {

            console.error("Telegram notification failed");

            process.exitCode = 1;
        }
    }


    if (!reportSaved) {

        process.exitCode = 1;
    }
}


main().catch(() => {

    console.error("CI reporting failed");

    process.exitCode = 1;
});