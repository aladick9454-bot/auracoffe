const test = require("node:test");

const assert = require("node:assert/strict");


const BASE_URL =

    "https://aura-coffee-api-2lty.onrender.com";


const WEBSITE_URL =

    "https://aladick9454-bot.github.io/auracoffe/";


async function request(url, options = {}) {

    return fetch(url, {

        ...options,

        redirect: "manual",

        signal: AbortSignal.timeout(90000)
    });
}


test("Public website is available", async () => {

    const response = await request(WEBSITE_URL);


    assert.equal(response.status, 200);


    const html = await response.text();


    assert.ok(html.length > 100);


    assert.match(html, /AURA/i);
});


test("Backend health endpoint works", async () => {

    const response = await request(

        `${BASE_URL}/health`
    );


    assert.equal(response.status, 200);


    const body = await response.json();


    assert.equal(body.ok, true);
});


test("Database readiness endpoint works", async () => {

    const response = await request(

        `${BASE_URL}/ready`
    );


    assert.equal(response.status, 200);


    const body = await response.json();


    assert.equal(body.ok, true);
});


const protectedRoutes = [

    "/api/monitoring/cloud/admin",

    "/api/protection/summary",

    "/api/protection/blocks",

    "/api/protection/events",

    "/api/ci/summary",

    "/api/ci/runs",

    "/api/migrations/summary",

    "/api/migrations/history"
];


for (const route of protectedRoutes) {

    test(`Unauthorized access denied: ${route}`, async () => {

        const response = await request(

            BASE_URL + route
        );


        assert.ok(

            [401, 403].includes(response.status),

            `Unexpected HTTP status: ${response.status}`
        );
    });
}


test("Unauthorized CI ingestion is denied", async () => {

    const response = await request(

        `${BASE_URL}/api/ci/ingest`,

        {

            method: "POST",

            headers: {

                "Content-Type": "application/json"
            },

            body: "{}"
        }
    );


    assert.equal(response.status, 401);
});