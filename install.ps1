#requires -Version 5.1
# Installs prerequisites (Node.js LTS), project dependencies, and creates a desktop shortcut.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host '== Teams Demo Attendees installer ==' -ForegroundColor Cyan

function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Node.js LTS via winget...'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget not found. Install Node.js LTS manually from https://nodejs.org then re-run.' }
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node installed but not on PATH yet. Open a new terminal and re-run Install.cmd.' }
}
Write-Host "Node $(node -v)"

$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe","$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ }
if (-not $edge) { Write-Warning 'Microsoft Edge not found. Install Edge, or set BROWSER_CHANNEL=chrome.' }

Write-Host 'Installing npm dependencies...'
npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Teams Demo Attendees.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = Join-Path $PSScriptRoot 'Start.cmd'; $s.WorkingDirectory = $PSScriptRoot; $s.Save()

Write-Host "`nInstalled. Launch with the desktop shortcut or Start.cmd (UI: http://localhost:3000)." -ForegroundColor Green
