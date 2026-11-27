
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const REQUIRED_FILES = [
    "server.js",
    "package.json",
    "package-lock.json",
    ".gitignore",
    "services/api-protection.js",
    "services/security-monitoring.js",
    "docs/API-PROTECTION.md",
    "docs/SECURITY-AUDIT.md",
    "docs/DISASTER-RECOVERY.md",
    "docs/PRODUCTION-READINESS.md",
    "docs/CLIENT-ACCEPTANCE.md",
    "docs/MAINTENANCE.md",
    "docs/OPERATING-COSTS.md",
    "tests/security-audit.test.cjs"
];

const REQUIRED_SCRIPTS = [
    "start",
    "check",
    "test",
    "db:status",
    "db:verify",
    "test:security",
    "test:performance",
    "test:monitoring",
    "test:backup",
    "release:preflight"
];

function checkRequiredFiles(
    root = ROOT,
    files = REQUIRED_FILES
) {
    return files.map(file => ({
        name: `File: ${file}`,
        passed: fs.existsSync(
            path.join(root, file)
        )
    }));
}

function checkRequiredScripts(
    scripts,
    required = REQUIRED_SCRIPTS
) {
    return required.map(name => ({
        name: `Script: ${name}`,
        passed:
            typeof scripts?.[name] === "string" &&
            scripts[name].trim().length > 0
    }));
}

function validateBaseUrl(value) {
    try {
        const url = new URL(value);

        const localHosts = [
            "localhost",
            "127.0.0.1",
            "[::1]"
        ];

        if (url.username || url.password) {
            return false;
        }

        if (
            url.pathname !== "/" ||
            url.search ||
            url.hash
        ) {
            return false;
        }

        return (
            url.protocol === "https:" ||
            (
                url.protocol === "http:" &&
                localHosts.includes(url.hostname)
            )
        );
    } catch {
        return false;
    }
}

async function checkEndpoint(
    baseUrl,
    endpoint,
    fetchImpl = globalThis.fetch
) {
    const startedAt = Date.now();

    try {
        const response = await fetchImpl(
            new URL(endpoint, baseUrl),
            {
                redirect: "manual",
                signal: AbortSignal.timeout(15000)
            }
        );

        return {
            name: `Endpoint: ${endpoint}`,
            passed: response.status === 200,
            status: response.status,
            durationMs: Date.now() - startedAt
        };
    } catch (error) {
        return {
            name: `Endpoint: ${endpoint}`,
            passed: false,
            error: error.name,
            durationMs: Date.now() - startedAt
        };
    }
}

function summarize(results) {
    const passed = results.filter(
        result => result.passed === true
    ).length;

    const failed = results.length - passed;

    return {
        total: results.length,
        passed,
        failed,
        ready: results.length > 0 && failed === 0
    };
}

async function main() {
    const baseUrl =
        process.env.READINESS_BASE_URL ||
        "http://127.0.0.1:3001";

    if (!validateBaseUrl(baseUrl)) {
        throw new Error(
            "Invalid READINESS_BASE_URL"
        );
    }

    const packageJson = JSON.parse(
        fs.readFileSync(
            path.join(ROOT, "package.json"),
            "utf8"
        )
    );

    const results = [
        ...checkRequiredFiles(),
        ...checkRequiredScripts(
            packageJson.scripts
        )
    ];

    for (const endpoint of [
        "/",
        "/health",
        "/ready"
    ]) {
        results.push(
            await checkEndpoint(
                baseUrl,
                endpoint
            )
        );
    }

    console.log(
        "\nAURA COFFEE — PRODUCTION READINESS\n"
    );

    console.log(
        `Version: ${packageJson.version}`
    );

    console.log(
        `Checked at: ${new Date().toISOString()}\n`
    );

    for (const result of results) {
        const status = result.passed
            ? "PASS"
            : "FAIL";

        const duration =
            result.durationMs !== undefined
                ? ` (${result.durationMs} ms)`
                : "";

        console.log(
            `[${status}] ${result.name}${duration}`
        );
    }

    const summary = summarize(results);

    console.log("\n---------------------------");
    console.log(`Total: ${summary.total}`);
    console.log(`Passed: ${summary.passed}`);
    console.log(`Failed: ${summary.failed}`);

    console.log(
        summary.ready
            ? "\nREADINESS CHECK: PASSED"
            : "\nREADINESS CHECK: FAILED"
    );

    process.exitCode = summary.ready ? 0 : 1;
}

if (require.main === module) {
    main().catch(error => {
        console.error(
            "Readiness check error:",
            error.name
        );

        process.exitCode = 1;
    });
}

module.exports = {
    checkRequiredFiles,
    checkRequiredScripts,
    validateBaseUrl,
    checkEndpoint,
    summarize
};
