
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    isValidVersion,
    validateVersions,
    validateTag,
    validateChangelog,
    checkReleaseFiles,
    summarize
} = require("../scripts/release-gate.cjs");

test("Stable semantic version is accepted", () => {
    assert.equal(isValidVersion("1.1.0"), true);
});

test("Zero version is accepted", () => {
    assert.equal(isValidVersion("0.0.0"), true);
});

test("Incomplete version is rejected", () => {
    assert.equal(isValidVersion("1.1"), false);
});

test("Version with prefix is rejected", () => {
    assert.equal(isValidVersion("v1.1.0"), false);
});

test("Leading zero is rejected", () => {
    assert.equal(isValidVersion("01.1.0"), false);
});

test("Matching release versions pass", () => {
    const results = validateVersions(
        { version: "1.1.0" },
        {
            version: "1.1.0",
            packages: {
                "": { version: "1.1.0" }
            }
        },
        "1.1.0"
    );

    assert.equal(
        results.every(result => result.passed),
        true
    );
});

test("Package version mismatch fails", () => {
    const results = validateVersions(
        { version: "1.0.0" },
        {
            version: "1.1.0",
            packages: {
                "": { version: "1.1.0" }
            }
        },
        "1.1.0"
    );

    assert.equal(results[1].passed, false);
});

test("Lockfile version mismatch fails", () => {
    const results = validateVersions(
        { version: "1.1.0" },
        {
            version: "1.0.0",
            packages: {
                "": { version: "1.1.0" }
            }
        },
        "1.1.0"
    );

    assert.equal(results[2].passed, false);
});

test("Lockfile root version mismatch fails", () => {
    const results = validateVersions(
        { version: "1.1.0" },
        {
            version: "1.1.0",
            packages: {
                "": { version: "1.0.0" }
            }
        },
        "1.1.0"
    );

    assert.equal(results[3].passed, false);
});

test("Matching release tag is accepted", () => {
    assert.equal(
        validateTag("v1.1.0", "1.1.0"),
        true
    );
});

test("Incorrect release tag is rejected", () => {
    assert.equal(
        validateTag("v1.0.0", "1.1.0"),
        false
    );
});

test("Changelog contains release", () => {
    assert.equal(
        validateChangelog(
            "# Changelog\n## [1.1.0]",
            "1.1.0"
        ),
        true
    );
});

test("Dated changelog entry is accepted", () => {
    assert.equal(
        validateChangelog(
            "## [1.1.0] - 2026-11-28",
            "1.1.0"
        ),
        true
    );
});

test("Missing changelog release is rejected", () => {
    assert.equal(
        validateChangelog(
            "## [1.0.0]",
            "1.1.0"
        ),
        false
    );
});

test("Nonempty release file passes", () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "aura-release-")
    );

    try {
        fs.writeFileSync(
            path.join(directory, "release.md"),
            "Release notes"
        );

        const results = checkReleaseFiles(
            directory,
            ["release.md"]
        );

        assert.equal(results[0].passed, true);
    } finally {
        fs.rmSync(directory, {
            recursive: true,
            force: true
        });
    }
});

test("Empty release file fails", () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "aura-release-")
    );

    try {
        fs.writeFileSync(
            path.join(directory, "release.md"),
            ""
        );

        const results = checkReleaseFiles(
            directory,
            ["release.md"]
        );

        assert.equal(results[0].passed, false);
    } finally {
        fs.rmSync(directory, {
            recursive: true,
            force: true
        });
    }
});

test("Missing release file fails", () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "aura-release-")
    );

    try {
        const results = checkReleaseFiles(
            directory,
            ["missing.md"]
        );

        assert.equal(results[0].passed, false);
    } finally {
        fs.rmSync(directory, {
            recursive: true,
            force: true
        });
    }
});

test("Successful checks allow release", () => {
    assert.deepEqual(
        summarize([
            { passed: true },
            { passed: true }
        ]),
        {
            total: 2,
            passed: 2,
            failed: 0,
            ready: true
        }
    );
});

test("Failed check blocks release", () => {
    assert.equal(
        summarize([
            { passed: true },
            { passed: false }
        ]).ready,
        false
    );
});

test("Empty checks block release", () => {
    assert.equal(summarize([]).ready, false);
});
