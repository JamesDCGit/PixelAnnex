#!/usr/bin/env pwsh
# PixelAnnex deploy script
# - Verifies the version triad (CODE_VERSION / SERVER_VERSION / CACHE_VERSION) match
# - Pulls latest from GitHub on the production droplet
# - Restarts the main PM2 process
# - Tails the startup log to confirm the new version booted and bots aren't disabled
#
# Usage: .\deploy.ps1            # full pre-flight + deploy
#        .\deploy.ps1 -SkipCheck  # bypass version triad check (NOT recommended)

param(
    [switch]$SkipCheck
)

$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$htmlFile = Join-Path $repoRoot 'pixelworld_v5.html'
$serverFile = Join-Path $repoRoot 'server.js'
$swFile = Join-Path $repoRoot 'sw.js'

# ── Pre-flight: version triad must match ────────────────────────────
if (-not $SkipCheck) {
    Write-Host '[deploy] Checking version triad...' -ForegroundColor Cyan

    $codeVer = (Select-String -Path $htmlFile -Pattern "const CODE_VERSION\s*=\s*'([^']+)'" |
                Select-Object -First 1).Matches.Groups[1].Value
    $serverVer = (Select-String -Path $serverFile -Pattern "const SERVER_VERSION\s*=\s*'([^']+)'" |
                  Select-Object -First 1).Matches.Groups[1].Value
    $cacheVerRaw = (Select-String -Path $swFile -Pattern "const CACHE_VERSION\s*=\s*'([^']+)'" |
                    Select-Object -First 1).Matches.Groups[1].Value
    # CACHE_VERSION is prefixed 'pixelannex-v' — strip for comparison
    $cacheVer = $cacheVerRaw -replace '^pixelannex-v', ''

    Write-Host ('  CODE_VERSION   (html)    = ' + $codeVer)
    Write-Host ('  SERVER_VERSION (server)  = ' + $serverVer)
    Write-Host ('  CACHE_VERSION  (sw)      = ' + $cacheVer + '  (raw: ' + $cacheVerRaw + ')')

    if ($codeVer -ne $serverVer -or $codeVer -ne $cacheVer) {
        Write-Host ''
        Write-Host '[deploy] VERSION MISMATCH - refusing to deploy.' -ForegroundColor Red
        Write-Host '  All three constants must match exactly:'
        Write-Host '    pixelworld_v5.html  CODE_VERSION'
        Write-Host '    server.js           SERVER_VERSION'
        Write-Host '    sw.js               CACHE_VERSION  (with pixelannex-v prefix)'
        Write-Host ''
        Write-Host '  This is the v76 trap - see CLAUDE.md. Mismatch causes infinite client reload loop.'
        Write-Host '  Override with: .\deploy.ps1 -SkipCheck'
        exit 1
    }
    Write-Host ('[deploy] Versions match: ' + $codeVer) -ForegroundColor Green
}

# ── Check working tree is clean for version-bearing files ───────────
$status = git status --porcelain pixelworld_v5.html server.js sw.js
if ($status) {
    Write-Host ''
    Write-Host '[deploy] Uncommitted changes in version-bearing files:' -ForegroundColor Yellow
    Write-Host $status
    Write-Host '  Production will not see these (deploy uses git pull on the server).'
    Write-Host '  Commit + push first, then re-run deploy.'
    exit 1
}

# ── Check branch is pushed ──────────────────────────────────────────
$ahead = git rev-list --count '@{u}..HEAD' 2>$null
if ($ahead -and ([int]$ahead -gt 0)) {
    Write-Host ''
    Write-Host ('[deploy] Local branch is ' + $ahead + ' commit(s) ahead of remote.') -ForegroundColor Yellow
    Write-Host '  Push first, then re-run deploy.'
    exit 1
}

# ── Deploy ──────────────────────────────────────────────────────────
Write-Host ''
Write-Host '[deploy] SSH -> git pull -> pm2 restart...' -ForegroundColor Cyan

$deployCmd = 'export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH && cd /var/www/PixelAnnex && git pull && pm2 restart pixelannex --update-env'

ssh -i ~/.ssh/id_ed25519_pixelannex -o StrictHostKeyChecking=no root@134.209.74.81 $deployCmd
if ($LASTEXITCODE -ne 0) {
    Write-Host '[deploy] SSH command failed' -ForegroundColor Red
    exit 1
}

# ── Post-flight: verify the new version booted + bots are enabled ───
Write-Host ''
Write-Host '[deploy] Waiting 3s for process to settle...' -ForegroundColor Cyan
Start-Sleep -Seconds 3

Write-Host '[deploy] Checking startup logs...' -ForegroundColor Cyan
$logCheckCmd = 'export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH && pm2 logs pixelannex --lines 30 --nostream --raw 2>&1 | tail -25'
$logs = ssh -i ~/.ssh/id_ed25519_pixelannex -o StrictHostKeyChecking=no root@134.209.74.81 $logCheckCmd

Write-Host $logs

$problems = @()
if ($logs -match 'BOTS DISABLED') {
    $problems += 'DISABLE_BOTS env var is set - bots will not paint.'
    $problems += '  Fix: ssh ... DISABLE_BOTS="" pm2 restart pixelannex --update-env'
}
if (-not ($logs -match 'PixelAnnex server')) {
    $problems += 'Could not find "PixelAnnex server" banner in recent logs.'
    $problems += '  Process may not have restarted cleanly - check pm2 status.'
}

if ($problems.Count -gt 0) {
    Write-Host ''
    Write-Host '[deploy] Post-flight WARNINGS:' -ForegroundColor Yellow
    $problems | ForEach-Object { Write-Host $_ }
    exit 2
}

Write-Host ''
Write-Host '[deploy] Done. Tell user to hard-refresh (Ctrl+Shift+R) to bust SW cache.' -ForegroundColor Green
