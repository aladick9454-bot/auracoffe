
# ==========================================
# AURA COFFEE - AUTOMATED BACKUP ENGINE
# ==========================================

$ErrorActionPreference = "Stop"

$backupRoot = Join-Path `
    $env:USERPROFILE "AURA-Backups"

$configPath = Join-Path `
    $backupRoot "backup.env"

$logPath = Join-Path `
    $backupRoot "backup-history.jsonl"

$lockPath = Join-Path `
    $backupRoot "backup.lock"

$startedAt = Get-Date

$backupId = `
    (Get-Date -Format "yyyy-MM-dd_HH-mm-ss") +
    "_" +
    [Guid]::NewGuid().ToString("N").Substring(0, 8)

$backupName = "backup_$backupId"

$backupDir = Join-Path `
    $backupRoot $backupName

$success = $false
$errorMessage = $null
$lockStream = $null
$remoteExportPath = $null
$config = @{}


# ==========================================
# HELPERS
# ==========================================

function Invoke-Docker {

    param(
        [Parameter(Mandatory = $true)]
        [string[]]$DockerArgs
    )

    & docker @DockerArgs

    if ($LASTEXITCODE -ne 0) {

        throw "Docker command failed (exit $LASTEXITCODE)"

    }

}


function Write-BackupLog {

    param(
        [string]$Message
    )

    $time = Get-Date -Format "HH:mm:ss"

    Write-Host "[$time] $Message"

}


function Read-BackupConfig {

    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {

        throw "Backup configuration not found"

    }

    $values = @{}

    foreach ($line in Get-Content $Path) {

        if (
            [string]::IsNullOrWhiteSpace($line) -or
            $line.StartsWith("#")
        ) {
            continue
        }

        $parts = $line -split "=", 2

        if ($parts.Count -eq 2) {

            $values[$parts[0]] = $parts[1]

        }

    }

    return $values

}


# ==========================================
# MAIN BACKUP PROCESS
# ==========================================

try {

    New-Item `
        -ItemType Directory `
        -Force `
        -Path $backupRoot | Out-Null


    # Prevent concurrent backup executions.

    $lockStream = [System.IO.File]::Open(

        $lockPath,

        [System.IO.FileMode]::OpenOrCreate,

        [System.IO.FileAccess]::ReadWrite,

        [System.IO.FileShare]::None

    )


    $config = Read-BackupConfig `
        -Path $configPath


    foreach ($key in @(

        "PGHOST",
        "PGPORT",
        "PGDATABASE",
        "PGUSER",
        "PGPASSWORD",
        "PGSSLMODE",
        "POSTGRES_IMAGE",
        "N8N_CONTAINER",
        "RETENTION_DAYS"

    )) {

        if (
            -not $config.ContainsKey($key) -or
            [string]::IsNullOrWhiteSpace(
                $config[$key]
            )
        ) {

            throw "Missing configuration: $key"

        }

    }


    $retentionDays = `
        [int]$config["RETENTION_DAYS"]

    if (
        $retentionDays -lt 1 -or
        $retentionDays -gt 365
    ) {

        throw "Invalid retention period"

    }


    Write-BackupLog "Checking Docker"

    Invoke-Docker -DockerArgs @(
        "info",
        "--format",
        "{{.ServerVersion}}"
    )


    New-Item `
        -ItemType Directory `
        -Path $backupDir | Out-Null


    # ======================================
    # POSTGRESQL BACKUP
    # ======================================

    Write-BackupLog "Backing up PostgreSQL"

    $mount = `
        "type=bind,source=$backupDir,target=/backup"

    Invoke-Docker -DockerArgs @(

        "run",

        "--rm",

        "--env-file",

        $configPath,

        "--mount",

        $mount,

        $config["POSTGRES_IMAGE"],

        "pg_dump",

        "--format=custom",

        "--no-owner",

        "--no-privileges",

        "--no-password",

        "--file=/backup/database.dump"

    )


    $databasePath = Join-Path `
        $backupDir "database.dump"

    if (
        -not (Test-Path $databasePath) -or
        (Get-Item $databasePath).Length -le 0
    ) {

        throw "Database backup is missing or empty"

    }


    # ======================================
    # VERIFY DATABASE ARCHIVE
    # ======================================

    Write-BackupLog "Checking database archive"

    Invoke-Docker -DockerArgs @(

        "run",

        "--rm",

        "--mount",

        "$mount,readonly",

        $config["POSTGRES_IMAGE"],

        "pg_restore",

        "--list",

        "/backup/database.dump"

    ) | Out-Null


    # ======================================
    # N8N WORKFLOW EXPORT
    # ======================================

    Write-BackupLog "Exporting n8n workflows"

    $remoteExportPath = `
        "/tmp/aura-workflows-$backupId.json"

    Invoke-Docker -DockerArgs @(

        "exec",

        $config["N8N_CONTAINER"],

        "n8n",

        "export:workflow",

        "--all",

        "--output=$remoteExportPath"

    )


    $workflowPath = Join-Path `
        $backupDir "workflows.json"

    $containerSource = `
        "$($config['N8N_CONTAINER']):$remoteExportPath"

    Invoke-Docker -DockerArgs @(

        "cp",

        $containerSource,

        $workflowPath

    )


    $workflows = Get-Content `
        $workflowPath `
        -Raw | ConvertFrom-Json

    $workflowCount = @($workflows).Count

    if (
        $null -eq $workflows -or
        $workflowCount -lt 1
    ) {

        throw "No workflows exported"

    }


    # ======================================
    # CHECKSUMS
    # ======================================

    Write-BackupLog "Generating SHA-256 checksums"

    $files = @(

        foreach ($name in @(

            "database.dump",

            "workflows.json"

        )) {

            $path = Join-Path `
                $backupDir $name

            $file = Get-Item $path

            $hash = Get-FileHash `
                -Path $path `
                -Algorithm SHA256

            [ordered]@{

                name = $name

                size_bytes = $file.Length

                sha256 = $hash.Hash

            }

        }

    )


    # ======================================
    # MANIFEST
    # ======================================

    $manifest = [ordered]@{

        project = "AURA COFFEE"

        backup_id = $backupId

        created_at = `
            (Get-Date).ToUniversalTime().ToString("o")

        status = "completed"

        postgres_image = `
            $config["POSTGRES_IMAGE"]

        workflow_count = $workflowCount

        files = $files

    }

    $manifestPath = Join-Path `
        $backupDir "manifest.json"

    $manifest |
        ConvertTo-Json -Depth 10 |
        Set-Content `
            -Path $manifestPath `
            -Encoding UTF8


    # ======================================
    # FINAL INTEGRITY CHECK
    # ======================================

    foreach ($entry in $files) {

        $path = Join-Path `
            $backupDir $entry.name

        $actualHash = (
            Get-FileHash `
                -Path $path `
                -Algorithm SHA256
        ).Hash

        if ($actualHash -ne $entry.sha256) {

            throw "Checksum mismatch: $($entry.name)"

        }

    }


    $success = $true

    Write-BackupLog "Backup completed successfully"

    Write-BackupLog "Workflows exported: $workflowCount"

    Write-BackupLog "Backup folder: $backupDir"


    # ======================================
    # RETENTION POLICY
    # ======================================

    try {

        $cutoff = `
            (Get-Date).AddDays(-$retentionDays)

        Get-ChildItem `
            -Path $backupRoot `
            -Directory |

        Where-Object {

            $_.Name -match `
                '^backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-f0-9]{8}$' -and

            $_.LastWriteTime -lt $cutoff -and

            $_.FullName -ne $backupDir -and

            -not (
                $_.Attributes -band
                [IO.FileAttributes]::ReparsePoint
            ) -and

            (
                Test-Path (
                    Join-Path `
                        $_.FullName "manifest.json"
                )
            )

        } |

        ForEach-Object {

            Write-BackupLog `
                "Removing expired backup: $($_.Name)"

            Remove-Item `
                -LiteralPath $_.FullName `
                -Recurse `
                -Force

        }

    }
    catch {

        Write-Warning "Retention cleanup failed"

    }

}
catch {

    $errorMessage = $_.Exception.Message

    Write-Host `
        "BACKUP FAILED: $errorMessage" `
        -ForegroundColor Red

    if (
        $lockStream -and
        (Test-Path $backupDir)
    ) {

        $failedMarker = Join-Path `
            $backupDir "FAILED.txt"

        $errorMessage |
            Set-Content `
                -Path $failedMarker `
                -Encoding UTF8

    }

}
finally {

    if (
        $remoteExportPath -and
        $config["N8N_CONTAINER"]
    ) {

        & docker exec `
            $config["N8N_CONTAINER"] `
            rm -f `
            $remoteExportPath 2>$null |
            Out-Null

    }


    $finishedAt = Get-Date

    $record = [ordered]@{

        backup_id = $backupId

        started_at = `
            $startedAt.ToUniversalTime().ToString("o")

        finished_at = `
            $finishedAt.ToUniversalTime().ToString("o")

        duration_seconds = [Math]::Round(

            ($finishedAt - $startedAt).TotalSeconds,

            2

        )

        status = if ($success) {
            "completed"
        }
        else {
            "failed"
        }

        folder = $backupName

        error = $errorMessage

    }


    if ($lockStream) {

        try {

            $record |
                ConvertTo-Json -Compress |
                Add-Content `
                    -Path $logPath `
                    -Encoding UTF8

        }
        finally {

            $lockStream.Dispose()

        }

    }

}

# ==========================================
# AURA COFFEE - BACKUP STATUS NOTIFICATIONS
# ==========================================

if ($lockStream) {

    try {

        $statusRoot = Join-Path `
            $env:USERPROFILE "AURA-Backup-Status"

        New-Item `
            -ItemType Directory `
            -Force `
            -Path $statusRoot |
            Out-Null

        $statusFile = Join-Path `
            $statusRoot "backup-status.json"

        $publicStatus = [ordered]@{

            project = "AURA COFFEE"

            backup_id = $backupId

            checked_at = `
                (Get-Date).ToUniversalTime().ToString("o")

            status = if ($success) {
                "completed"
            }
            else {
                "failed"
            }

            duration_seconds = [Math]::Round(
                ((Get-Date) - $startedAt).TotalSeconds,
                2
            )

        }


        # ==================================
        # SAVE LOCAL STATUS
        # ==================================

        $publicStatus |
            ConvertTo-Json |
            Set-Content `
                -Path $statusFile `
                -Encoding UTF8

        Write-Host `
            "Backup status file created" `
            -ForegroundColor Green


        # ==================================
        # SEND STATUS TO N8N
        # ==================================

        if (
            $config["BACKUP_WEBHOOK_URL"] -and
            $config["BACKUP_WEBHOOK_SECRET"]
        ) {

            try {

                 $requestParams = @{
    Uri = $config["BACKUP_WEBHOOK_URL"]
    Method = "Post"
    Headers = @{
        "x-backup-secret" = $config["BACKUP_WEBHOOK_SECRET"]
    }
    ContentType = "application/json"
    Body = ($publicStatus | ConvertTo-Json -Compress)
    TimeoutSec = 15
}

Invoke-RestMethod @requestParams | Out-Null

                Write-Host `
                    "Backup status sent to n8n" `
                    -ForegroundColor Green

            }
            catch {

                Write-Warning `
                    "Backup status delivery failed"

            }

        }
        else {

            Write-Warning `
                "Backup webhook configuration is missing"

        }

    }
    catch {

        Write-Warning `
            "Could not publish backup status"

    }

}


# ==========================================
# FINAL EXIT STATUS
# ==========================================

if ($success) {

    Write-Host `
        "AURA COFFEE BACKUP: SUCCESS" `
        -ForegroundColor Green

    exit 0

}

exit 1
