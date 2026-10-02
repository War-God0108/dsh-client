# dsh-session-delete verification (dsh >= 0.2)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File verify-session-delete.ps1
#   powershell -ExecutionPolicy Bypass -File verify-session-delete.ps1 -Token <token>
#
# The token is auto-detected from the desktop client host log when omitted.
# ASCII-only + only default-loaded .NET types: Windows PowerShell 5.1 reads .ps1
# files as ANSI and does not load System.Net.Http by default.
param(
    [string]$BaseUrl = "http://127.0.0.1:3080",
    [string]$Token = ""
)

$ErrorActionPreference = "Continue"
$fail = 0
$warn = 0
function Pass([string]$m) { Write-Host "  [PASS] $m" -ForegroundColor Green }
function Fail([string]$m) { $script:fail += 1; Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Warn([string]$m) { $script:warn += 1; Write-Host "  [WARN] $m" -ForegroundColor Yellow }

Write-Host "== dsh-session-delete verification @ $BaseUrl ==" -ForegroundColor Cyan

$uri = [uri]$BaseUrl
$hostName = $uri.Host
$port = if ($uri.Port -gt 0) { $uri.Port } else { 80 }

if (-not $Token) {
    $log = Join-Path $env:APPDATA "dsh-client\dsh-host.log"
    if (Test-Path $log) {
        $m = Select-String -Path $log -Pattern "token=([A-Za-z0-9_\-]+)" | Select-Object -Last 1
        if ($m) { $Token = $m.Matches[0].Groups[1].Value; Write-Host "  (token auto-detected from dsh-host.log)" -ForegroundColor DarkGray }
    }
}
if (-not $Token) { Warn "no token: dsh >= 0.2 gates the page and API; pass -Token to check online" }

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$root = if ($Token) { "$BaseUrl/?token=$Token" } else { "$BaseUrl/" }

# -- 1) page + boot manifest -------------------------------------------------
$entry = $null
try {
    $page = Invoke-WebRequest -Uri $root -WebSession $session -UseBasicParsing -TimeoutSec 15
    Pass "page served (HTTP 200, $($page.Content.Length) bytes)"
    $html = $page.Content
    $i = $html.IndexOf("__DSH_BOOT__")
    if ($i -lt 0) { Fail "__DSH_BOOT__ not found (token gate answered instead?)" }
    else {
        $s = $html.IndexOf("=", $i) + 1
        $e = $html.IndexOf("</script>", $s)
        $boot = $html.Substring($s, $e - $s).Trim().TrimEnd(";") | ConvertFrom-Json
        $entry = $boot.entries | Where-Object { $_.id -eq "dsh-session-delete" }
        if ($entry) { Pass "boot manifest contains dsh-session-delete (rev=$($entry.rev)) - browser half composed" }
        else { Fail "boot manifest lacks dsh-session-delete: restart the DSH host / desktop app after installing the plugin (new client entries are scanned at boot)" }
    }
} catch { Fail "page unreachable: $($_.Exception.Message)" }

# -- 2) browser bundle -------------------------------------------------------
if ($entry) {
    try {
        $bundle = (Invoke-WebRequest -Uri "$BaseUrl/$($entry.url)" -WebSession $session -UseBasicParsing -TimeoutSec 15).Content
        Pass "bundle served ($($bundle.Length) bytes)"
        foreach ($needle in @("sidebar.workspaces.session.menu.item", "/api/dsd", "shell.overlay", "Delete session")) {
            if ($bundle.Contains($needle)) { Pass "bundle contains $needle" }
            else { Fail "bundle lacks $needle (stale installed copy? re-run: node electron/install-plugin.mjs)" }
        }
    } catch { Fail "bundle download failed: $($_.Exception.Message)" }
}

# -- 3) host capability probe ------------------------------------------------
if ($Token) {
    try {
        $body = '{"endpoint":"probe"}'
        $res = Invoke-WebRequest -Uri "$BaseUrl/api/dsd" -Method Post -Body $body -ContentType "application/json" -WebSession $session -UseBasicParsing -TimeoutSec 15
        $probe = $res.Content | ConvertFrom-Json
        if ($probe.ok -eq $true) {
            Pass ("/api/dsd probe -> disposedHook={0} nativeTeardown={1} canStopLive={2} located={3}" -f $probe.value.disposedHook, $probe.value.nativeTeardown, $probe.value.canStopLive, $probe.value.located)
            if ($probe.value.canStopLive -eq $true) { Pass "live sessions can be stopped (deletion of a running session is supported)" }
            else { Warn "canStopLive is not true: the running host still has the OLD plugin code in memory - restart the DSH host / desktop app" }
            if ($probe.value.located -eq $true) { Pass "persistence backend can locate session files" }
            else { Fail "located=false: this persistence backend cannot locate session files" }
        } else { Fail "probe failed: $($probe.error.message)" }
    } catch { Warn "/api/dsd probe failed: $($_.Exception.Message)" }
}

Write-Host ""
Write-Host "== manual checklist (open $root) ==" -ForegroundColor Cyan
Write-Host "  1. Hover a session row -> the ... button -> the menu should end with a red 'Delete session' item"
Write-Host "  2. Click it: a confirmation dialog appears ('Delete session' + the session name + Cancel/Delete)"
Write-Host "  3. Confirm on a junk session: the row disappears at once; the session folder is gone from"
Write-Host "     ~/.dsh/sessions/<cwd-slug>/<sessionId>/ (refresh the page: the session stays gone)"
Write-Host "  4. Cancel: nothing is sent, the session keeps running"
Write-Host ""
if ($fail -eq 0) { Write-Host "ALL AUTOMATED CHECKS PASSED ($warn warning(s))" -ForegroundColor Green }
else { Write-Host "$fail CHECK(S) FAILED (see above)" -ForegroundColor Red }
