$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

$databaseDirectory = Join-Path $root "database"

$outputFile = Join-Path $databaseDirectory "baseline.sql"

$tempFile = Join-Path $databaseDirectory "baseline.tmp.sql"

if (-not $env:PRODUCTION_DATABASE_URL) {
    throw "PRODUCTION_DATABASE_URL is required"
}

New-Item `
    -ItemType Directory `
    -Path $databaseDirectory `
    -Force | Out-Null

if (Test-Path -LiteralPath $outputFile) {

    if ((Get-Item $outputFile).Length -eq 0) {

        Remove-Item -LiteralPath $outputFile

    } else {

        throw "baseline.sql already exists. Do not overwrite it."
    }
}

docker info --format "{{.ServerVersion}}" | Out-Null

if ($LASTEXITCODE -ne 0) {
    throw "Docker is not running"
}

Write-Host "Exporting database schema using Docker..."

try {

    docker run --rm `
        --env PRODUCTION_DATABASE_URL `
        --mount "type=bind,source=$databaseDirectory,target=/output" `
        postgres:18 `
        sh -c 'pg_dump --schema-only --schema=public --no-owner --no-privileges --no-password --dbname="$PRODUCTION_DATABASE_URL" --file=/output/baseline.tmp.sql'

    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump failed"
    }

    if (-not (Test-Path -LiteralPath $tempFile)) {
        throw "Schema export was not created"
    }

    if ((Get-Item $tempFile).Length -lt 100) {
        throw "Schema export is unexpectedly small"
    }

    Move-Item `
        -LiteralPath $tempFile `
        -Destination $outputFile

    $hash = Get-FileHash `
        -Path $outputFile `
        -Algorithm SHA256

    Write-Host ""

    Write-Host "BASELINE EXPORT COMPLETED" `
        -ForegroundColor Green

    Write-Host "File: $outputFile"

    Write-Host "SHA256: $($hash.Hash)"

    Write-Host "Size: $((Get-Item $outputFile).Length) bytes"

} finally {

    if (Test-Path -LiteralPath $tempFile) {

        Remove-Item `
            -LiteralPath $tempFile `
            -Force
    }
}