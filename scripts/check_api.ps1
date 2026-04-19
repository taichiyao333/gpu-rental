# ════════════════════════════════════════════════════════════════════
#  GPURental + GPU Street Fighter (THE LOBBY) - API 疎通確認スクリプト
#  使い方: .\scripts\check_api.ps1 [-base http://localhost:3000]
# ════════════════════════════════════════════════════════════════════
param(
    [string]$base   = 'http://localhost:3000',
    [string]$token  = '',    # 管理者JWTトークン (任意)
    [switch]$sf     = $false # SF エンドポイントのみチェック
)

$ok   = { param($s) Write-Host "[OK  $s]" -ForegroundColor Green  -NoNewline; Write-Host }
$err  = { param($s) Write-Host "[ERR $s]" -ForegroundColor Red    -NoNewline; Write-Host }
$warn = { param($s) Write-Host "[---  $s]" -ForegroundColor Yellow -NoNewline; Write-Host }

function Check($method, $path, $label, $expectedCodes = @(200), $body = $null, $needsAuth = $false) {
    $url = $base + $path
    $headers = @{ 'Content-Type' = 'application/json' }
    if ($needsAuth -and $token) { $headers['Authorization'] = "Bearer $token" }
    try {
        $params = @{ Uri = $url; Method = $method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 10 }
        if ($body) { $params['Body'] = ($body | ConvertTo-Json -Compress) }
        $r = Invoke-WebRequest @params
        $preview = $r.Content.Substring(0, [Math]::Min(80, $r.Content.Length)) -replace "`n",""
        & $ok " $($r.StatusCode)] $label | $preview"
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($expectedCodes -contains $code) {
            & $warn " $code ] $label (expected non-200)"
        } else {
            & $err " $code ] $label"
        }
    }
}

Write-Host ""
Write-Host "════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  GPU Platform API チェック — $base" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

if (-not $sf) {
    Write-Host "━━ ① プラットフォーム基本 ━━" -ForegroundColor White
    Check GET  '/api/health'                    'Health Check'
    Check GET  '/api/gpus'                      'GPU 一覧'
    Check GET  '/api/gpus/stats'                'GPU 統計'
    Check POST '/api/auth/login'                'Auth/Login (400=正常)' @(400,422) @{}
    Check POST '/api/auth/register'             'Auth/Register (400=正常)' @(400,422) @{}
    Check POST '/api/billing/webhook'           'Stripe Webhook (400=正常)' @(400,500) $null
    Check GET  '/socket.io/?EIO=4&transport=polling' 'Socket.IO'
    Check GET  '/portal/'                       'ポータル UI'
    Check GET  '/lobby/'                        'THE LOBBY UI'
    Check GET  '/workspace/'                    'ワークスペース UI'
    Check GET  '/admin/'                        '管理ダッシュボード UI'
    Write-Host ""
}

Write-Host "━━ ② GPU SF (THE REFEREE) ━━" -ForegroundColor Magenta
Check GET  '/api/sf/stats/public'               'SF パブリック統計'
Check GET  '/api/sf/nodes'                      'SF ノード一覧'
Check POST '/api/sf/nodes/heartbeat'            'SF ハートビート (401=正常)' @(401)
Check POST '/api/sf/raid'                       'SF レイド (401=正常)' @(401)
Check POST '/api/sf/match'                      'SF マッチ (401=正常)' @(401)
Check GET  '/api/auth/agent-token'              'エージェントトークン取得 (401=正常)' @(401)
Write-Host ""

if ($token) {
    Write-Host "━━ ③ 管理者 API (JWT あり) ━━" -ForegroundColor Yellow
    Check GET  '/api/admin/sf/raid-jobs'        'Admin SF Raid Jobs'        @(200) $null $true
    Check GET  '/api/admin/sf/raid-jobs/stats'  'Admin SF Raid Stats'       @(200) $null $true
    Check GET  '/api/admin/sf/point-logs'       'Admin SF Point Logs'       @(200) $null $true
    Check GET  '/api/admin/overview'            'Admin Overview'            @(200) $null $true
    Check GET  '/api/admin/users'               'Admin Users'               @(200) $null $true
    Write-Host ""
}

Write-Host "━━ ④ Node.js プロセス ━━" -ForegroundColor White
Get-Process node -ErrorAction SilentlyContinue |
    Select-Object Id, CPU,
        @{N='RSS_MB';E={[Math]::Round($_.WorkingSet/1MB,1)}},
        StartTime |
    Format-Table -AutoSize
