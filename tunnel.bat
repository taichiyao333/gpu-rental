@echo off
chcp 65001 >nul
title GPU Rental - Cloudflare Tunnel

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║       GPU RENTAL + GPU SF - 外部公開 (Cloudflare)        ║
echo ╚══════════════════════════════════════════════════════════╝
echo.

:: Check cloudflared
where cloudflared >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] cloudflared が見つかりません
    echo.
    echo 以下のコマンドでインストールしてください:
    echo   winget install Cloudflare.cloudflared
    echo   または https://github.com/cloudflare/cloudflared/releases
    pause
    exit /b 1
)

:: Check if server is running
curl -s -o nul -w "%%{http_code}" http://localhost:3000/api/health >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] サーバーが localhost:3000 で応答していません
    echo        start.bat を先に実行してください
    echo.
    set /p CONTINUE="続行しますか? (y/N): "
    if /i not "%CONTINUE%"=="y" exit /b 1
)

echo [INFO] クイックトンネルを起動中...
echo [INFO] 公開URL が割り当てられます（無料・ランダム）
echo.
echo ══════════════════════════════════════════════════════════
echo   起動後、表示される https://*.trycloudflare.com の
echo   URLを以下のページで利用できます:
echo.
echo   [URL]/portal/          ポータル (GPU予約)
echo   [URL]/lobby/           THE LOBBY (GPU SF マッチ)
echo   [URL]/workspace/       ワークスペース
echo   [URL]/provider/        プロバイダー登録
echo   [URL]/admin/           管理ダッシュボード
echo.
echo   ★ SF URL例:
echo   [URL]/workspace/?raid_job=42   レイドジョブ追跡
echo   [URL]/workspace/?match=abc123  1on1マッチ追跡
echo ══════════════════════════════════════════════════════════
echo.

:: 環境変数ファイルがあれば読み込み
if exist .env (
    for /f "usebackq tokens=1,2 delims==" %%A in (".env") do (
        if "%%A"=="CLOUDFLARE_TUNNEL_TOKEN" set CF_TOKEN=%%B
    )
)

:: Named tunnel (token) vs Quick tunnel
if defined CF_TOKEN (
    echo [INFO] Named Tunnel (CLOUDFLARE_TUNNEL_TOKEN) で起動します
    cloudflared tunnel --token %CF_TOKEN% run
) else (
    echo [INFO] Quick Tunnel（ランダムURL）で起動します
    echo [INFO] 固定URLには CLOUDFLARE_TUNNEL_TOKEN を .env に設定してください
    echo.
    cloudflared tunnel --url http://localhost:3000
)

pause
