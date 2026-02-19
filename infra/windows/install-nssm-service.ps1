param(
  [string]$NssmExe = "C:\\tools\\nssm\\win64\\nssm.exe",
  [string]$ServerDir = "C:\\mc-server",
  [string]$ServiceName = "MinecraftPaper"
)

if (-not (Test-Path $NssmExe)) {
  throw "nssm.exe not found at $NssmExe"
}

& $NssmExe install $ServiceName "$ServerDir\\start-paper.bat"
& $NssmExe set $ServiceName AppDirectory $ServerDir
& $NssmExe set $ServiceName Start SERVICE_AUTO_START
& $NssmExe set $ServiceName AppExit Default Restart
& $NssmExe set $ServiceName AppRestartDelay 5000
& $NssmExe set $ServiceName ObjectName LocalSystem

Write-Host "Service $ServiceName installed."
Write-Host "Start with: sc.exe start $ServiceName"
