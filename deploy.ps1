<#
.SYNOPSIS
    Deploy the static site in .\public to Cloudflare Pages (free plan).

.DESCRIPTION
    Without arguments: publishes .\public with Wrangler.
    With -Zip: creates rankpulse-site.zip for the dashboard "Upload assets" flow.

.PARAMETER ProjectName
    Cloudflare Pages project name. Defaults to rankpulse.

.PARAMETER Branch
    Branch name recorded for the deployment. Defaults to main (production).

.PARAMETER Zip
    Only build rankpulse-site.zip, do not deploy.

.EXAMPLE
    .\deploy.ps1

.EXAMPLE
    .\deploy.ps1 -Zip
#>

[CmdletBinding()]
param(
    [string]$ProjectName = 'rankpulse',
    [string]$Branch = 'main',
    [switch]$Zip
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$publicDir = Join-Path $root 'public'
$zipPath = Join-Path $root 'rankpulse-site.zip'

if (-not (Test-Path (Join-Path $publicDir 'index.html'))) {
    throw "public\index.html not found. Run this script from the project root."
}

# Node is not on PATH on this machine, so prefer the full path to npx.cmd.
$npx = 'C:\Program Files\nodejs\npx.cmd'
if (-not (Test-Path $npx)) {
    $npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
}
if (-not $npx) {
    throw "npx not found. Install Node.js 18+ or add it to PATH."
}

if ($Zip) {
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    # Zip the CONTENTS of public so index.html sits at the archive root.
    Compress-Archive -Path (Join-Path $publicDir '*') -DestinationPath $zipPath
    Write-Host ""
    Write-Host "Created $zipPath" -ForegroundColor Green
    Write-Host "Upload it at: Workers & Pages > $ProjectName > Create new deployment > Upload assets"
    exit 0
}

Write-Host "Deploying public\ to Cloudflare Pages project '$ProjectName' (branch: $Branch)..." -ForegroundColor Cyan
& $npx wrangler@latest pages deploy $publicDir --project-name $ProjectName --branch $Branch
if ($LASTEXITCODE -ne 0) {
    throw "Wrangler deploy failed with exit code $LASTEXITCODE. Run 'npx wrangler@latest login' first."
}
Write-Host ""
Write-Host "Done. Production URL: https://$ProjectName.pages.dev" -ForegroundColor Green
