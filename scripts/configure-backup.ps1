
$ErrorActionPreference = "Stop"

$backupRoot = Join-Path `
    $env:USERPROFILE "AURA-Backups"

New-Item `
    -ItemType Directory `
    -Force `
    -Path $backupRoot | Out-Null

$configPath = Join-Path `
    $backupRoot "backup.env"

$existingConfig = @{}

if (Test-Path -LiteralPath $configPath) {

    foreach ($line in Get-Content -LiteralPath $configPath) {

        $parts = $line -split "=", 2

        if (
            $parts.Count -eq 2 -and
            -not $line.TrimStart().StartsWith("#")
        ) {
            $existingConfig[$parts[0].Trim()] = $parts[1]
        }

    }

}

$pgHost = Read-Host "Neon direct host"
$pgDatabase = Read-Host "Database name"
$pgUser = Read-Host "Database user"

$securePassword = Read-Host `
    "Database password" `
    -AsSecureString

$pointer = `
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
        $securePassword
    )

try {

    $pgPassword = `
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
            $pointer
        )

    $pgVersion = Read-Host `
        "PostgreSQL major version (example: 17)"

    $n8nContainer = Read-Host `
        "Docker n8n container name"

$pgVersion = $pgVersion.Trim()

if ($pgVersion -match '^(\d{2})(?:\.\d+)*$') {

    $pgVersion = $Matches[1]

}
else {

    throw "Invalid PostgreSQL version. Enter 16, 17, 18 or a full version like 17.5"

}

    if (
        [string]::IsNullOrWhiteSpace($pgHost) -or
        [string]::IsNullOrWhiteSpace($pgDatabase) -or
        [string]::IsNullOrWhiteSpace($pgUser) -or
        [string]::IsNullOrWhiteSpace($pgPassword) -or
        [string]::IsNullOrWhiteSpace($n8nContainer)
    ) {
        throw "Required configuration is missing"
    }

    $lines = @(

        "PGHOST=$pgHost"

        "PGPORT=5432"

        "PGDATABASE=$pgDatabase"

        "PGUSER=$pgUser"

        "PGPASSWORD=$pgPassword"

        "PGSSLMODE=require"

        "POSTGRES_IMAGE=postgres:$pgVersion"

        "N8N_CONTAINER=$n8nContainer"

        "RETENTION_DAYS=30"

    )

foreach ($key in @(
    "BACKUP_WEBHOOK_URL",
    "RESTORE_WEBHOOK_URL",
    "BACKUP_WEBHOOK_SECRET"
)) {

    if ($existingConfig.ContainsKey($key)) {

        $lines += "$key=$($existingConfig[$key])"

    }

}

    [System.IO.File]::WriteAllLines(
        $configPath,
        $lines,
        [System.Text.UTF8Encoding]::new($false)
    )

    Write-Host ""
    Write-Host "Configuration created:" `
        -ForegroundColor Green

    Write-Host $configPath

}
finally {

    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR(
        $pointer
    )

    Remove-Variable pgPassword `
        -ErrorAction SilentlyContinue

}
