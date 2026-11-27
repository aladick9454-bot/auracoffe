# ==========================================
# AURA COFFEE - DISASTER RECOVERY TEST
# ==========================================

param(
    [string]$BackupFolder = ""
)

$ErrorActionPreference = "Stop"

$backupRoot = Join-Path `
    $env:USERPROFILE "AURA-Backups"

$startedAt = Get-Date

$containerName = `
    "aura-restore-test-" +
    [Guid]::NewGuid().ToString("N").Substring(0, 8)

$containerCreated = $false
$success = $false


# ==========================================
# DOCKER HELPER
# ==========================================

function Invoke-Docker {

    param(
        [string[]]$DockerArgs
    )

    & docker @DockerArgs

    if ($LASTEXITCODE -ne 0) {

        throw "Docker command failed (exit $LASTEXITCODE)"

    }

}


try {

    # ======================================
    # SELECT BACKUP
    # ======================================

    if ([string]::IsNullOrWhiteSpace($BackupFolder)) {

        $latest = Get-ChildItem `
            -Path $backupRoot `
            -Directory |

        Where-Object {

            $_.Name -like "backup_*" -and

            (
                Test-Path (
                    Join-Path `
                        $_.FullName "manifest.json"
                )
            ) -and

            -not (
                Test-Path (
                    Join-Path `
                        $_.FullName "FAILED.txt"
                )
            )

        } |

        Sort-Object `
            Name `
            -Descending |

        Select-Object -First 1


        if (-not $latest) {

            throw "No completed backups found"

        }

        $BackupFolder = $latest.FullName

    }


    $BackupFolder = (
        Resolve-Path `
            -LiteralPath $BackupFolder
    ).Path


    if (
        Test-Path (
            Join-Path `
                $BackupFolder "FAILED.txt"
        )
    ) {

        throw "Selected backup is marked as failed"

    }


    $manifestPath = Join-Path `
        $BackupFolder "manifest.json"

    $manifest = Get-Content `
        $manifestPath `
        -Raw | ConvertFrom-Json


    if ($manifest.status -ne "completed") {

        throw "Backup is not completed"

    }


    if (
        $manifest.postgres_image -notmatch
        '^postgres:\d{2}$'
    ) {

        throw "Invalid PostgreSQL image"

    }


    Write-Host "Selected backup: $BackupFolder"


    # ======================================
    # VERIFY CHECKSUMS
    # ======================================

    foreach ($name in @(

        "database.dump",

        "workflows.json"

    )) {

        $entries = @(

            $manifest.files |

            Where-Object {
                $_.name -eq $name
            }

        )

        if ($entries.Count -ne 1) {

            throw "Invalid manifest entry: $name"

        }

        $entry = $entries[0]

        $path = Join-Path `
            $BackupFolder $name

        if (-not (Test-Path $path)) {

            throw "Missing backup file: $name"

        }

        $hash = (
            Get-FileHash `
                -Path $path `
                -Algorithm SHA256
        ).Hash

        if ($hash -ne $entry.sha256) {

            throw "Checksum mismatch: $name"

        }

        if (
            (Get-Item $path).Length -ne
            $entry.size_bytes
        ) {

            throw "File size mismatch: $name"

        }

        Write-Host `
            "PASS: checksum $name" `
            -ForegroundColor Green

    }


    # ======================================
    # VERIFY N8N EXPORT
    # ======================================

    $workflows = Get-Content `
        (Join-Path $BackupFolder "workflows.json") `
        -Raw | ConvertFrom-Json

    if (
        @($workflows).Count -ne
        $manifest.workflow_count
    ) {

        throw "Workflow count mismatch"

    }

    Write-Host `
        "PASS: n8n JSON export" `
        -ForegroundColor Green


    # ======================================
    # START ISOLATED DATABASE
    # ======================================

    $mount = `
        "type=bind,source=$BackupFolder,target=/backup,readonly"

    $testPassword = `
        [Guid]::NewGuid().ToString("N")

    Invoke-Docker -DockerArgs @(

        "run",

        "-d",

        "--name",

        $containerName,

        "--network",

        "none",

        "-e",

        "POSTGRES_PASSWORD=$testPassword",

        "-e",

        "POSTGRES_DB=aura_restore_test",

        "--mount",

        $mount,

        $manifest.postgres_image

    ) | Out-Null

    $containerCreated = $true


    # ======================================
    # WAIT FOR POSTGRESQL
    # ======================================

    $ready = $false

    for ($i = 0; $i -lt 60; $i++) {

        & docker exec `
            $containerName `
            pg_isready `
            -U postgres `
            -d aura_restore_test `
            -h 127.0.0.1 2>$null |
            Out-Null

        if ($LASTEXITCODE -eq 0) {

            $ready = $true

            break

        }

        Start-Sleep -Seconds 2

    }

    if (-not $ready) {

        throw "Test PostgreSQL did not start"

    }


    # ======================================
    # RESTORE DATABASE
    # ======================================

    Write-Host "Restoring database..."

    Invoke-Docker -DockerArgs @(

        "exec",

        $containerName,

        "pg_restore",

        "-U",

        "postgres",

        "-d",

        "aura_restore_test",

        "--no-owner",

        "--no-privileges",

        "--exit-on-error",

        "/backup/database.dump"

    )

    Write-Host `
        "PASS: PostgreSQL restore" `
        -ForegroundColor Green


    # ======================================
    # CHECK REQUIRED TABLES
    # ======================================

    $requiredTables = @(
    "monitoring_snapshots",
    "monitoring_incidents",
    "monitoring_incident_events",
    "monitoring_sla_policies",
    "monitoring_incident_escalations",
    "monitoring_recovery_policies",
    "monitoring_recovery_jobs",
    "monitoring_recovery_events",
    "monitoring_recovery_notifications",
    "monitoring_backup_runs",
    "monitoring_restore_tests",
    "monitoring_backup_alert_state",
    "monitoring_heartbeats",
    "monitoring_cloud_checks",
    "monitoring_cloud_alert_state",
    "monitoring_cloud_notifications",
    "security_events",
    "security_alerts",
    "security_rate_limits",
    "security_ip_blocks",
    "security_protection_events",
    "monitoring_ci_runs",
    "schema_migrations",
    "database_metadata"
)

$releaseMigration = Invoke-Docker -DockerArgs @(
    "exec",
    $containerName,
    "psql",
    "-U",
    "postgres",
    "-d",
    "aura_restore_test",
    "-v",
    "ON_ERROR_STOP=1",
    "-tA",
    "-c",
    "SELECT COUNT(*) FROM public.schema_migrations WHERE name ~ '^[0-9]+_release_management[.]sql$';"
)

if ([int]$releaseMigration -gt 0) {

    $requiredTables += @(
        "application_releases",
        "application_release_events"
    )

    Write-Host "Release migration detected" `
        -ForegroundColor Cyan

} else {

    Write-Host "Release migration not applied yet" `
        -ForegroundColor Yellow

}

Write-Host "Required tables: $($requiredTables.Count)"


    foreach ($table in $requiredTables) {

        $query = `
            "SELECT COUNT(*) FROM public.$table;"

        $result = Invoke-Docker -DockerArgs @(

            "exec",

            $containerName,

            "psql",

            "-U",

            "postgres",

            "-d",

            "aura_restore_test",

            "-v",

            "ON_ERROR_STOP=1",

            "-tA",

            "-c",

            $query

        )

        Write-Host `
            "PASS: $table - $result rows" `
            -ForegroundColor Green

    }


    # ======================================
    # GENERATE RESTORE REPORT
    # ======================================

    $duration = [Math]::Round(

        ((Get-Date) - $startedAt).TotalSeconds,

        2

    )


    $report = [ordered]@{

        backup_id = $manifest.backup_id

        tested_at = `
            (Get-Date).ToUniversalTime().ToString("o")

        status = "passed"

        duration_seconds = $duration

        checked_tables = $requiredTables

        workflow_count = $manifest.workflow_count

    }

    $reportPath = Join-Path `
        $BackupFolder "restore-report.json"

    $report |
        ConvertTo-Json -Depth 10 |
        Set-Content `
            -Path $reportPath `
            -Encoding UTF8


    $success = $true

    Write-Host ""

    Write-Host `
        "DISASTER RECOVERY TEST: PASSED" `
        -ForegroundColor Green

    Write-Host "Duration: $duration seconds"

}
catch {

    Write-Host `
        "RESTORE TEST FAILED: $($_.Exception.Message)" `
        -ForegroundColor Red

}
finally {

    # ======================================
    # REMOVE TEMPORARY CONTAINER
    # ======================================

    if ($containerCreated) {

        & docker rm `
            -f `
            -v `
            $containerName |
            Out-Null

        if ($LASTEXITCODE -ne 0) {

            Write-Warning `
                "Temporary container cleanup failed"

        }

    }

}


# ==========================================
# EXIT STATUS
# ==========================================

# ==========================================
# RESTORE TEST STATUS NOTIFICATION
# ==========================================

try {
    if ($manifest -and $manifest.backup_id) {

        $configPath = Join-Path $env:USERPROFILE "AURA-Backups\backup.env"

        $config = @{}

        foreach ($line in Get-Content -LiteralPath $configPath) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }

            if ($line.TrimStart().StartsWith("#")) {
                continue
            }

            $parts = $line -split "=", 2

            if ($parts.Count -eq 2) {
                $config[$parts[0].Trim()] = $parts[1].Trim()
            }
        }

        if (
            $config["RESTORE_WEBHOOK_URL"] -and
            $config["BACKUP_WEBHOOK_SECRET"]
        ) {

            $restoreStatus = "failed"
            $checkedTablesCount = 0

            if ($success) {
                $restoreStatus = "passed"
                $checkedTablesCount = @($requiredTables).Count
            }

            $restoreData = @{
                project = "AURA COFFEE"
                backup_id = $manifest.backup_id
                tested_at = (Get-Date).ToUniversalTime().ToString("o")
                status = $restoreStatus
                duration_seconds = [Math]::Round(
                    ((Get-Date) - $startedAt).TotalSeconds,
                    2
                )
                checked_tables_count = $checkedTablesCount
            }

            if ($success -and $report) {
                $restoreData.tested_at = $report.tested_at
                $restoreData.duration_seconds = $report.duration_seconds
            }

            $requestParams = @{
                Uri = $config["RESTORE_WEBHOOK_URL"]
                Method = "Post"
                Headers = @{
                    "x-backup-secret" = $config["BACKUP_WEBHOOK_SECRET"]
                }
                ContentType = "application/json"
                Body = ($restoreData | ConvertTo-Json -Compress)
                TimeoutSec = 90
                ErrorAction = "Stop"
            }

$response = Invoke-RestMethod @requestParams

if ($response.ok -ne $true) {
    Write-Warning (
        "Response contains ok field: " +
        ($null -ne $response.ok)
    )

    throw "Restore status was not accepted"
}

            Write-Host "Restore status synchronized" -ForegroundColor Green

        } else {
            Write-Warning "Restore webhook configuration missing"
        }

    } else {
        Write-Warning "Restore status skipped: backup ID unavailable"
    }

} catch {

    Write-Warning "Restore status delivery failed"

    if ($_.Exception.Response) {

        Write-Warning (
            "HTTP status: " +
            [int]$_.Exception.Response.StatusCode
        )

    } else {

        Write-Warning (
            "Error type: " +
            $_.Exception.GetType().Name
        )

    }

if ($_.Exception.Message -eq "Restore status was not accepted") {
    Write-Warning "Webhook response validation failed"
}

    $success = $false
}


# ==========================================
# FINAL EXIT STATUS
# ==========================================

if ($success) {
    exit 0
}

exit 1