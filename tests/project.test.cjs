const test = require("node:test");

const assert = require("node:assert/strict");

const fs = require("node:fs");

const path = require("node:path");


const root = path.resolve(__dirname, "..");


function read(relativePath) {

    return fs.readFileSync(

        path.join(root, relativePath),

        "utf8"
    );
}


test("package.json contains start script", () => {

    const pkg = JSON.parse(

        read("package.json")
    );


    assert.equal(

        typeof pkg.scripts?.start,

        "string"
    );


    assert.ok(

        pkg.scripts.start.length > 0
    );
});


test("Express is installed", () => {

    assert.doesNotThrow(() => {

        require.resolve("express");
    });
});


test("PostgreSQL driver is installed", () => {

    assert.doesNotThrow(() => {

        require.resolve("pg");
    });
});


test("Server contains exactly one startup", () => {

    const server = read("server.js");


    const matches = server.match(

        /\bapp\s*\.\s*listen\s*\(/g

    ) || [];


    assert.equal(matches.length, 1);
});


test("Security monitoring module is connected", () => {

    const server = read("server.js");


    assert.ok(

        server.includes("security-monitoring")
    );


    assert.ok(

        server.includes("createSecurityMonitoring")
    );
});


test("API protection module is connected", () => {

    const server = read("server.js");


    assert.ok(

        server.includes("api-protection")
    );


    assert.match(

        server,

        /app\.use\s*\(\s*apiProtection\.middleware\s*\)/
    );
});


test("CI monitoring module is connected", () => {

    const server = read("server.js");


    assert.ok(

        server.includes("ci-monitoring")
    );


    assert.match(

        server,

        /registerCiMonitoringRoutes\s*\(\s*app/
    );
});


test("Protection dashboard exists", () => {

    const html = read("admin-monitoring.html");


    assert.match(

        html,

        /id=["']protection-dashboard["']/
    );
});


test("CI dashboard exists", () => {

    const html = read("admin-monitoring.html");


    assert.match(

        html,

        /id=["']ci-dashboard["']/
    );
});


test("Required monitoring modules export functions", () => {

    const modules = [

        [

            "../services/backup-monitoring",

            "registerBackupMonitoringRoutes"
        ],

        [

            "../services/cloud-monitoring",

            "registerCloudMonitoringRoutes"
        ],

        [

            "../services/security-monitoring",

            "createSecurityMonitoring"
        ],

        [

            "../services/api-protection",

            "createApiProtection"
        ],

        [

            "../services/ci-monitoring",

            "registerCiMonitoringRoutes"
        ]
    ];


    for (const [modulePath, exportName] of modules) {

        const loaded = require(modulePath);


        assert.equal(

            typeof loaded[exportName],

            "function",

            `${modulePath}: ${exportName}`
        );
    }
});