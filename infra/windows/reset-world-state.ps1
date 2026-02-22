param(
  [string]$ServerDir = "C:\mc-server",
  [string]$ServiceName = "MinecraftPaper",
  [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-PropertyValue {
  param(
    [string]$Path,
    [string]$Key,
    [string]$DefaultValue
  )

  if (-not (Test-Path $Path)) {
    return $DefaultValue
  }

  $line = Get-Content $Path | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($line)) {
    return $DefaultValue
  }

  return $line.Substring($Key.Length + 1)
}

Write-Host "ServerDir: $ServerDir"
if (-not (Test-Path $ServerDir)) {
  throw "ServerDir does not exist: $ServerDir"
}

$serverProps = Join-Path $ServerDir "server.properties"
$levelName = Get-PropertyValue -Path $serverProps -Key "level-name" -DefaultValue "world"

$worldPaths = @(
  (Join-Path $ServerDir $levelName),
  (Join-Path $ServerDir "${levelName}_nether"),
  (Join-Path $ServerDir "${levelName}_the_end")
)

$serviceExists = $false
try {
  Get-Service -Name $ServiceName -ErrorAction Stop | Out-Null
  $serviceExists = $true
} catch {
  $serviceExists = $false
}

if ($serviceExists) {
  Write-Host "Stopping service: $ServiceName"
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

foreach ($path in $worldPaths) {
  if (Test-Path $path) {
    Write-Host "Removing world path: $path"
    Remove-Item -Path $path -Recurse -Force
  } else {
    Write-Host "World path not present (skip): $path"
  }
}

if (-not $NoStart) {
  if ($serviceExists) {
    Write-Host "Starting service: $ServiceName"
    Start-Service -Name $ServiceName
  } else {
    $startBat = Join-Path $ServerDir "start-paper.bat"
    if (-not (Test-Path $startBat)) {
      throw "Service not found and start script missing: $startBat"
    }
    Write-Host "Service not found; starting with batch file: $startBat"
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$startBat`"" -WorkingDirectory $ServerDir | Out-Null
  }
}

Write-Host "World reset complete."
