param(
  [string]$ServerDir = "C:\\mc-server",
  [string]$PaperBuildUrl = "https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/500/downloads/paper-1.20.4-500.jar"
)

New-Item -ItemType Directory -Path $ServerDir -Force | Out-Null
Set-Location $ServerDir

Invoke-WebRequest -Uri $PaperBuildUrl -OutFile "paper.jar"
"eula=true" | Set-Content -Path "eula.txt"

if (-not (Test-Path "start-paper.bat")) {
  "@echo off`r`njava -Xms6G -Xmx10G -jar paper.jar --nogui" | Set-Content -Path "start-paper.bat"
}

Write-Host "Paper installed at $ServerDir"
