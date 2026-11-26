"use strict";

const test = require("node:test");

const assert = require("node:assert/strict");

const fs = require("node:fs");

const os = require("node:os");

const path = require("node:path");


const {

    calculateChecksum,

    validateMigrationSql,

    loadMigrations,

    compareMigrations

} = require("../scripts/migrate.cjs");


function createDirectory(t) {

    const directory = fs.mkdtempSync(

        path.join(os.tmpdir(), "aura-migrations-")
    );


    t.after(() => {

        fs.rmSync(directory, {

            recursive: true,

            force: true
        });
    });


    return directory;
}


test("SHA256 checksum is valid", () => {

    const checksum = calculateChecksum("SELECT 1;");


    assert.match(

        checksum,

        /^[a-f0-9]{64}$/
    );
});


test("Same SQL produces same checksum", () => {

    assert.equal(

        calculateChecksum("SELECT 1;"),

        calculateChecksum("SELECT 1;")
    );
});


test("Changed SQL produces different checksum", () => {

    assert.notEqual(

        calculateChecksum("SELECT 1;"),

        calculateChecksum("SELECT 2;")
    );
});


test("Windows and Linux line endings match", () => {

    assert.equal(

        calculateChecksum("SELECT 1;\r\n"),

        calculateChecksum("SELECT 1;\n")
    );
});


test("Migration files are loaded in version order", t => {

    const directory = createDirectory(t);


    fs.writeFileSync(

        path.join(directory, "0002_second.sql"),

        "SELECT 2;"
    );


    fs.writeFileSync(

        path.join(directory, "0001_first.sql"),

        "SELECT 1;"
    );


    const migrations = loadMigrations(directory);


    assert.deepEqual(

        migrations.map(item => item.version),

        ["0001", "0002"]
    );
});


test("Duplicate versions are rejected", t => {

    const directory = createDirectory(t);


    fs.writeFileSync(

        path.join(directory, "0001_first.sql"),

        "SELECT 1;"
    );


    fs.writeFileSync(

        path.join(directory, "0001_second.sql"),

        "SELECT 2;"
    );


    assert.throws(

        () => loadMigrations(directory),

        /Duplicate migration version/
    );
});


test("Invalid filenames are rejected", t => {

    const directory = createDirectory(t);


    fs.writeFileSync(

        path.join(directory, "invalid.sql"),

        "SELECT 1;"
    );


    assert.throws(

        () => loadMigrations(directory),

        /Invalid migration filename/
    );
});


test("Empty migrations are rejected", () => {

    assert.throws(

        () => validateMigrationSql("", "empty.sql"),

        /Empty migration/
    );
});


test("Explicit COMMIT is rejected", () => {

    assert.throws(

        () => validateMigrationSql(

            "SELECT 1;\nCOMMIT;",

            "unsafe.sql"
        ),

        /Unsupported transaction command/
    );
});


test("Pending migrations are detected", () => {

    const files = [

        {

            version: "0001",

            name: "0001_first.sql",

            checksum: "a"
        },

        {

            version: "0002",

            name: "0002_second.sql",

            checksum: "b"
        }
    ];


    const applied = [files[0]];


    const pending = compareMigrations(

        files,

        applied
    );


    assert.equal(pending.length, 1);

    assert.equal(pending[0].version, "0002");
});


test("Changed applied migration is rejected", () => {

    const files = [

        {

            version: "0001",

            name: "0001_first.sql",

            checksum: "new"
        }
    ];


    const applied = [

        {

            version: "0001",

            name: "0001_first.sql",

            checksum: "old"
        }
    ];


    assert.throws(

        () => compareMigrations(files, applied),

        /checksum or name mismatch/
    );
});


test("Missing applied migration is rejected", () => {

    assert.throws(

        () => compareMigrations(

            [],

            [

                {

                    version: "0001",

                    name: "0001_first.sql",

                    checksum: "a"
                }
            ]
        ),

        /Applied migration is missing/
    );
});


test("Out-of-order migration is rejected", () => {

    const files = [

        {

            version: "0001",

            name: "0001_first.sql",

            checksum: "a"
        },

        {

            version: "0002",

            name: "0002_second.sql",

            checksum: "b"
        }
    ];


    assert.throws(

        () => compareMigrations(

            files,

            [files[1]]
        ),

        /Out-of-order migration/
    );
});


test("Already applied migrations are skipped", () => {

    const files = [

        {

            version: "0001",

            name: "0001_first.sql",

            checksum: "a"
        }
    ];


    assert.deepEqual(

        compareMigrations(files, files),

        []
    );
});


test("Actual project migration files are valid", () => {

    const migrations = loadMigrations();


    assert.ok(migrations.length >= 2);


    assert.equal(

        migrations[0].version,

        "0001"
    );
});