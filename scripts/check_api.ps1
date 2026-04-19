<#
.SYNOPSIS
    GPU Rental Platform + GPU SF — API エンドポイント疎通確認スクリプト

.DESCRIPTION
    全主要APIエンドポイントのHTTP疎通を確認し、結果をカラー表示します。
    サーバーが起動している状態で実行してください。

.PARAMETER Base
    APIベースURL (デフォルト: http://localhost:3000)

.PARAMETER Remote
    本番URLを使う場合に指定 (例: -Remote https://gpurental.jp)

.PARAMETER SfOnly
    GPU SF 関連エンドポイントのみチェック

.PARAMETER Verbose
    詳細なレスポンスボディを表示

.EXAMPLE
    .\scripts\check_api.ps1
    .\scripts\check_api.ps1 -Remote https://gpurental.jp
    .\scripts\check_api.ps1 -SfOnly
#>
param(
    [string]$Base    = 'http://localhost:3000',
    [string]$Remote  = '',
    [switch]$SfOnly,
    [switch]$ShowBody
)

if ($Remote) { $Base = $Remote }

# ─── ヘルパー ──────────────────────────────────────────────────────────────
$ok_count  = 0
$err_count = 0

function Check-Endpoint {
    param(
        [string]$Method,
        [string]$Path,
        [string]$Label,
        [int[]] $AcceptCodes = @(200, 201, 204),
        [hashtable]$Headers  = @{},
        [string]$Body        = $null,
        [string]$ContentType = 'application/json'
    )

    $uri = $Base + $Path
    $params = @{
        Uri             = $uri
        Method          = $Method
        UseBasicParsing = $true
        TimeoutSec      = 10
        Headers         = $Headers
        ErrorAction     = 'Stop'
    }
    if ($Body) {
        $params.Body        = $Body
        $params.ContentType = $ContentType
    }

    try {
        $r = Invoke-WebRequest @params
        $code = $r.StatusCode
        if ($AcceptCodes -contains $code) {
            $script:ok_count++
            $short = $r.Content.Substring(0, [Math]::Min(100, $r.Content.Length)) -replace "`n",' '
            Write-Host " [OK $code]  $Label" -ForegroundColor Green
            if ($ShowBody) { Write-Host "            $short" -ForegroundColor DarkGray }
        } else {
            $script:err_count++
            Write-Host " [!  $code]  $Label — unexpected status" -ForegroundColor Yellow
        }
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($AcceptCodes -contains $code) {
            $script:ok_count++
            Write-Host " [OK $code]  $Label (expected error)" -ForegroundColor Green
        } else {
            $script:err_count++
            Write-Host " [ERR $code] $Label | $($_.Exception.Message.Substring(0,[Math]::Min(80,$_.Exception.Message.Length)))" -ForegroundColor Red
        }
    }
}

# ─── ヘッダー ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  GPU RENTAL + ⚡ GPU SF  — API チェック" -ForegroundColor Cyan
Write-Host "  Target: $Base" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# ─── 基本エンドポイント ─────────────────────────────────────────────────────
if (-not $SfOnly) {
    Write-Host "【Platform Core】" -ForegroundColor Yellow
    Check-Endpoint GET  '/api/health'                  'ヘルスチェック'
    Check-Endpoint GET  '/api/gpus'                    'GPU一覧 (public)'
    Check-Endpoint GET  '/api/gpus/stats'              'GPU統計 (public)'
    Check-Endpoint POST '/api/auth/login'              'Auth/Login エンドポイント' -AcceptCodes @(400,422,401) -Body '{}'
    Write-Host ""

    Write-Host "【Pages (HTML)】" -ForegroundColor Yellow
    Check-Endpoint GET '/portal/'    'ポータルページ'
    Check-Endpoint GET '/lobby/'     'THE LOBBY ページ'
    Check-Endpoint GET '/workspace/' 'ワークスペースページ' -AcceptCodes @(200,302)
    Check-Endpoint GET '/provider/'  'プロバイダーページ'
    Check-Endpoint GET '/admin/'     '管理ダッシュボード'   -AcceptCodes @(200,302)
    Write-Host ""
}

# ─── GPU SF エンドポイント ─────────────────────────────────────────────────
Write-Host "【⚡ GPU Street Fighter】" -ForegroundColor Magenta

Check-Endpoint GET '/api/sf/stats/public' 'SF公開統計 (認証不要)'

# 認証なしアクセスは 401 が返れば正常
Check-Endpoint GET  '/api/sf/nodes'           'SFノード一覧 (要auth→401)' -AcceptCodes @(401,403)
Check-Endpoint POST '/api/sf/match'           'SFマッチ (要auth→401)'     -AcceptCodes @(401,403,400) -Body '{}'
Check-Endpoint POST '/api/sf/raid'            'SFレイド (要auth→401)'     -AcceptCodes @(401,403,400) -Body '{}'

# Admin エンドポイント (認証なし = 401)
Check-Endpoint GET '/api/admin/sf/raid-jobs'         'Admin: レイドジョブ一覧 (要admin→401)' -AcceptCodes @(401,403)
Check-Endpoint GET '/api/admin/sf/raid-jobs/stats'   'Admin: レイドジョブ統計 (要admin→401)' -AcceptCodes @(401,403)
Write-Host ""

# ─── Socket.IO ────────────────────────────────────────────────────────────
if (-not $SfOnly) {
    Write-Host "【Socket.IO & Webhooks】" -ForegroundColor Yellow
    Check-Endpoint GET '/socket.io/?EIO=4&transport=polling' 'Socket.IO ポーリング接続'
    Check-Endpoint POST '/api/payments/webhook' 'Stripe Webhook (署名なし→400)' -AcceptCodes @(400,401,403,500) -Body '{}'
    Write-Host ""

    # ─── Node.js プロセス確認 ─────────────────────────────────────────────────
    Write-Host "【Node.js Processes】" -ForegroundColor Yellow
    $procs = Get-Process node -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | Select-Object Id, CPU, @{N='RSS_MB';E={[Math]::Round($_.WorkingSet/1MB,1)}}, @{N='Started';E={$_.StartTime.ToString('HH:mm:ss')}} | Format-Table -AutoSize | Out-String | Write-Host -ForegroundColor DarkGray
    } else {
        Write-Host " [WARN] node プロセスが見つかりません" -ForegroundColor Yellow
    }
}

# ─── 結果サマリー ─────────────────────────────────────────────────────────
$total = $ok_count + $err_count
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
if ($err_count -eq 0) {
    Write-Host "  ✅ 全チェック通過: $ok_count / $total" -ForegroundColor Green
} else {
    Write-Host "  ❌ エラーあり: OK=$ok_count, ERR=$err_count / $total" -ForegroundColor Red
}
Write-Host "  チェック日時: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
