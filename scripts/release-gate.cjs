
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const REQUIRED_RELEASE_FILES = [
    "CHANGELOG.md",
    "docs/RELEASE-1.1.0.md",
    "docs/ROLLBACK.md",
    "docs/CLIENT-HANDOVER.md",
    "docs/PRODUCTION-READINESS.md",
    "docs/SECURITY-AUDIT.md",
    "docs/DISASTER-RECOVERY.md",
    ".github/workflows/release.yml"
];

function isValidVersion(version) {
    return (
        typeof version === "string" &&
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
            .test(version)
    );
}

function validateVersions(
    packageJson,
    lockJson,
    expectedVersion
) {
    return [
        {
            name: "Valid release version",
            passed: isValidVersion(expectedVersion)
        },
        {
            name: "Package version matches release",
            passed:
                packageJson.version === expectedVersion
        },
        {
            name: "Lockfile version matches release",
            passed:
                lockJson.version === expectedVersion
        },
        {
            name: "Lockfile root version matches release",
            passed:
                lockJson.packages?.[""]?.version ===
                expectedVersion
        }
    ];
}

function validateTag(tag, version) {
    return (
        isValidVersion(version) &&
        tag === `v${version}`
    );
}

function validateChangelog(content, version) {
    if (
        typeof content !== "string" ||
        !isValidVersion(version)
    ) {
        return false;
    }

    return content
        .split(/\r?\n/)
        .some(line =>
            line.trim() === `## [${version}]` ||
            line.trim().startsWith(
                `## [${version}] - `
            )
        );
}

function checkReleaseFiles(
    root = ROOT,
    files = REQUIRED_RELEASE_FILES
) {
    return files.map(file => {
        let passed = false;

        try {
            const stats = fs.statSync(
                path.join(root, file)
            );

            passed =
                stats.isFile() &&
                stats.size > 0;
        } catch {
            passed = false;
        }

        return {
            name: `Release file: ${file}`,
            passed
        };
    });
}

function summarize(results) {
    const passed = results.filter(
        result => result.passed === true
    ).length;

    return {
        total: results.length,
        passed,
        failed: results.length - passed,
        ready:
            results.length > 0 &&
            passed === results.length
    };
}

function main() {
    const packageJson = JSON.parse(
        fs.readFileSync(
            path.join(ROOT, "package.json"),
            "utf8"
        )
    );

    const lockJson = JSON.parse(
        fs.readFileSync(
            path.join(ROOT, "package-lock.json"),
            "utf8"
        )
    );

    const version =
        process.env.RELEASE_VERSION ||
        packageJson.version;

    const tag =
        process.env.RELEASE_TAG ||
        `v${version}`;

    const changelogPath =
        path.join(ROOT, "CHANGELOG.md");

    const changelog = fs.existsSync(changelogPath)
        ? fs.readFileSync(changelogPath, "utf8")
        : "";

    const results = [
        ...validateVersions(
            packageJson,
            lockJson,
            version
        ),
        {
            name: "Release tag matches version",
            passed: validateTag(tag, version)
        },
        {
            name: "Changelog contains release version",
            passed: validateChangelog(
                changelog,
                version
            )
        },
        ...checkReleaseFiles()
    ];

    console.log(
        "\nAURA COFFEE — RELEASE GATE\n"
    );

    console.log(`Version: ${version}`);
    console.log(`Tag: ${tag}\n`);

    for (const result of results) {
        console.log(
            `[${result.passed ? "PASS" : "FAIL"}] ` +
            result.name
        );
    }

    const summary = summarize(results);

    console.log("\n---------------------------");
    console.log(`Total: ${summary.total}`);
    console.log(`Passed: ${summary.passed}`);
    console.log(`Failed: ${summary.failed}`);

    console.log(
        summary.ready
            ? "\nRELEASE GATE: PASSED"
            : "\nRELEASE GATE: FAILED"
    );

    process.exitCode = summary.ready ? 0 : 1;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(
            "Release gate error:",
            error.name
        );

        process.exitCode = 1;
    }
}

module.exports = {
    isValidVersion,
    validateVersions,
    validateTag,
    validateChangelog,
    checkReleaseFiles,
    summarize
};
