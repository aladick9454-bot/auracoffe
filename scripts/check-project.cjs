const fs = require("node:fs");

const path = require("node:path");

const { spawnSync } = require("node:child_process");


const root = path.resolve(__dirname, "..");


const requiredFiles = [

    "server.js",

    "package.json",

    "admin-monitoring.html",

    "frontend/monitoring.js",

    "frontend/monitoring.css",

    "services/backup-monitoring.js",

    "services/cloud-monitoring.js",

    "services/security-monitoring.js",

    "services/api-protection.js",

    "services/ci-monitoring.js",

    "scripts/cloud-monitor.mjs",

    "scripts/backup.ps1",

    "scripts/restore-test.ps1",

    "scripts/report-ci.cjs",

    "tests/project.test.cjs",

    "tests/api-protection.test.cjs",

    "tests/database.test.cjs",

    "tests/smoke.test.cjs",

    ".github/workflows/cloud-monitoring.yml",

    ".github/workflows/ci.yml",

    ".github/workflows/production-smoke.yml"
];


const ignoredDirectories = new Set([

    "node_modules",

    ".git",

    "coverage",

    "dist",

    "backups"
]);


let failures = 0;


function pass(message) {

    console.log(`[PASS] ${message}`);
}


function fail(message) {

    console.error(`[FAIL] ${message}`);

    failures++;
}


function collectJavaScriptFiles(directory) {

    const files = [];


    for (const entry of fs.readdirSync(

        directory,

        { withFileTypes: true }

    )) {

        const fullPath = path.join(

            directory,

            entry.name
        );


        if (entry.isDirectory()) {

            if (!ignoredDirectories.has(entry.name)) {

                files.push(

                    ...collectJavaScriptFiles(fullPath)
                );
            }

            continue;
        }


        if (

            entry.isFile() &&

            /\.(js|cjs|mjs)$/.test(entry.name)

        ) {

            files.push(fullPath);
        }
    }


    return files;
}


console.log("AURA COFFEE PROJECT VALIDATION");

console.log("================================");


for (const file of requiredFiles) {

    const fullPath = path.join(root, file);


    if (

        fs.existsSync(fullPath) &&

        fs.statSync(fullPath).isFile()

    ) {

        pass(`Required file: ${file}`);

    } else {

        fail(`Missing file: ${file}`);
    }
}


const serverPath = path.join(root, "server.js");


if (fs.existsSync(serverPath)) {

    const server = fs.readFileSync(

        serverPath,

        "utf8"
    );


    const listenMatches =

        server.match(

            /\bapp\s*\.\s*listen\s*\(/g

        ) || [];


    if (listenMatches.length === 1) {

        pass("Exactly one app.listen()");

    } else {

        fail(

            `Expected one app.listen(), found ${listenMatches.length}`
        );
    }
}


const files = collectJavaScriptFiles(root);


for (const file of files) {

    const result = spawnSync(

        process.execPath,

        ["--check", file],

        {

            encoding: "utf8",

            timeout: 30000
        }
    );


    const relativePath = path.relative(root, file);


    if (result.status === 0) {

        pass(`Syntax: ${relativePath}`);

    } else {

        fail(`Syntax: ${relativePath}`);

        console.error(

            result.stderr ||

            result.error?.message ||

            "Unknown syntax error"
        );
    }
}


console.log("================================");

console.log(`JavaScript files checked: ${files.length}`);

console.log(`Failures: ${failures}`);


if (failures > 0) {

    process.exitCode = 1;

} else {

    console.log("PROJECT VALIDATION PASSED");
}