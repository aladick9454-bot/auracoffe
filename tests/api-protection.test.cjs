const test = require("node:test");

const assert = require("node:assert/strict");

const express = require("express");


const {

    createApiProtection

} = require("../services/api-protection");


function createResponse() {

    return {

        statusCode: 200,

        headers: {},

        body: null,


        set(name, value) {

            this.headers[name] = value;

            return this;
        },


        status(code) {

            this.statusCode = code;

            return this;
        },


        json(body) {

            this.body = body;

            return this;
        }
    };
}


function createRequest(

    path = "/api/test",

    method = "GET",

    ip = "192.0.2.77"

) {

    return {

        path,

        method,

        ip,

        socket: {

            remoteAddress: ip
        }
    };
}


function createPool(state) {

    return {

        calls: [],


        async query(sql, params) {

            this.calls.push({

                sql,

                params
            });


            return {

                rows: [state]
            };
        }
    };
}


test("Allowed public GET request", async () => {

    const pool = createPool({

        allowed: true,

        blocked: false,

        remaining: 119,

        retry_after: 0
    });


    const protection = createApiProtection(pool);

    const req = createRequest();

    const res = createResponse();


    let nextCalled = false;


    await protection.middleware(

        req,

        res,

        () => {

            nextCalled = true;
        }
    );


    assert.equal(nextCalled, true);

    assert.equal(res.statusCode, 200);

    assert.equal(

        res.headers["X-RateLimit-Limit"],

        "120"
    );

    assert.equal(

        res.headers["X-RateLimit-Remaining"],

        "119"
    );
});


test("Rate limit exceeded returns HTTP 429", async () => {

    const pool = createPool({

        allowed: false,

        blocked: false,

        remaining: 0,

        retry_after: 30
    });


    const protection = createApiProtection(pool);

    const res = createResponse();


    await protection.middleware(

        createRequest(),

        res,

        () => {

            assert.fail("Request must be rejected");
        }
    );


    assert.equal(res.statusCode, 429);

    assert.equal(res.body.ok, false);

    assert.equal(res.headers["Retry-After"], "30");
});


test("Blocked IP returns HTTP 403", async () => {

    const pool = createPool({

        allowed: false,

        blocked: true,

        remaining: 0,

        retry_after: 1800
    });


    const protection = createApiProtection(pool);

    const res = createResponse();


    await protection.middleware(

        createRequest(),

        res,

        () => {

            assert.fail("Blocked request was accepted");
        }
    );


    assert.equal(res.statusCode, 403);

    assert.equal(res.body.ok, false);

    assert.equal(res.body.retry_after, 1800);
});


test("Health endpoint bypasses rate limiting", async () => {

    const pool = {

        async query() {

            assert.fail("Database must not be queried");
        }
    };


    const protection = createApiProtection(pool);


    let nextCalled = false;


    await protection.middleware(

        createRequest("/health"),

        createResponse(),

        () => {

            nextCalled = true;
        }
    );


    assert.equal(nextCalled, true);
});


test("Monitoring API bypasses public rate limiting", async () => {

    const pool = {

        async query() {

            assert.fail("Unexpected rate limit query");
        }
    };


    const protection = createApiProtection(pool);


    let nextCalled = false;


    await protection.middleware(

        createRequest(

            "/api/monitoring/heartbeat",

            "POST"
        ),

        createResponse(),

        () => {

            nextCalled = true;
        }
    );


    assert.equal(nextCalled, true);
});


test("Invalid IP is rejected", async () => {

    const protection = createApiProtection({

        async query() {

            assert.fail("Invalid IP reached database");
        }
    });


    const res = createResponse();


    await protection.middleware(

        createRequest(

            "/api/test",

            "GET",

            "invalid-ip"
        ),

        res,

        () => {

            assert.fail("Invalid IP accepted");
        }
    );


    assert.equal(res.statusCode, 503);
});


test("Public write fails closed during database outage", async () => {

    const protection = createApiProtection({

        async query() {

            throw new Error("Test database unavailable");
        }
    });


    const res = createResponse();


    await protection.middleware(

        createRequest(

            "/api/test",

            "POST"
        ),

        res,

        () => {

            assert.fail("Unprotected write accepted");
        }
    );


    assert.equal(res.statusCode, 503);
});


test("Public read fails open during database outage", async () => {

    const protection = createApiProtection({

        async query() {

            throw new Error("Test database unavailable");
        }
    });


    let nextCalled = false;


    await protection.middleware(

        createRequest(),

        createResponse(),

        () => {

            nextCalled = true;
        }
    );


    assert.equal(nextCalled, true);
});


test("Admin login uses separate rate limit", async () => {

    const pool = createPool({

        allowed: true,

        blocked: false,

        remaining: 9,

        retry_after: 0
    });


    const protection = createApiProtection(pool);

    const res = createResponse();


    await protection.middleware(

        createRequest(

            "/admin/login",

            "POST"
        ),

        res,

        () => {}
    );


    assert.equal(

        pool.calls[0].params[1],

        "admin_login"
    );


    assert.equal(

        pool.calls[0].params[2],

        900
    );


    assert.equal(

        res.headers["X-RateLimit-Limit"],

        "10"
    );
});


test("Integration: Express returns real HTTP 429", async () => {

    const pool = createPool({

        allowed: false,

        blocked: false,

        remaining: 0,

        retry_after: 15
    });


    const protection = createApiProtection(pool);


    const app = express();


    app.use(protection.middleware);


    app.get("/api/test", (req, res) => {

        res.json({

            ok: true
        });
    });


    const server = await new Promise((resolve, reject) => {

        const instance = app.listen(

            0,

            "127.0.0.1",

            () => resolve(instance)
        );


        instance.once("error", reject);
    });


    try {

        const port = server.address().port;


        const response = await fetch(

            `http://127.0.0.1:${port}/api/test`,

            {

                signal: AbortSignal.timeout(5000)
            }
        );


        const body = await response.json();


        assert.equal(response.status, 429);

        assert.equal(body.ok, false);

        assert.equal(

            response.headers.get("retry-after"),

            "15"
        );

    } finally {

        await new Promise(resolve => {

            server.close(resolve);
        });
    }
});