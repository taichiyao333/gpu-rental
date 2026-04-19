@echo off
chcp 65001 >nul
title GPU Rental Platform + GPU SF

echo.
echo ╔═══════════════════════════════════════════════════════════╗
echo ║   GPU RENTAL PLATFORM + ⚡ GPU STREET FIGHTER            ║
echo ║   METADATALAB.INC  —  RTX A4500 Home GPU Rental          ║
echo ╚═══════════════════════════════════════════════════════════╝
echo.

:: ─── Node.js チェック ─────────────────────────────────────────────────
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js が未インストールです。
    echo         https://nodejs.org/ からインストールしてください。
    echo.
    pause
    exit /b 1
)

:: Node バージョン確認 (最低 18 以上)
for /f "tokens=1 delims=v" %%V in ('node --version') do (
    set NODE_VER=%%V
)
for /f "tokens=1 delims=." %%M in ('node -e "process.stdout.write(process.version.slice(1))"') do (
    set NODE_MAJOR=%%M
)
if %NODE_MAJOR% LSS 18 (
    echo [WARN] Node.js v18 以上を推奨します (現在: %NODE_MAJOR%)
    echo.
)

:: ─── node_modules チェック ────────────────────────────────────────────
if not exist node_modules (
    echo [INFO] node_modules がありません。インストールを実行します...
    npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install に失敗しました。
        pause
        exit /b 1
    )
)

:: ─── .env チェック ────────────────────────────────────────────────────
if not exist .env (
    echo [WARN] .env ファイルが見つかりません。
    if exist .env.example (
        echo [INFO] .env.example をコピーして .env を作成します...
        copy .env.example .env >nul
        echo [INFO] .env を作成しました。内容を確認・編集してください。
    ) else (
        echo [INFO] 最小構成の .env を作成します...
        (
            echo PORT=3000
            echo JWT_SECRET=change-me-in-production-%RANDOM%%RANDOM%
            echo NODE_ENV=development
            echo STORAGE_PATH=C:/gpu-rental-main/data
            echo DB_PATH=C:/gpu-rental-main/data/db/platform.db
        ) > .env
    )
    echo.
)

:: ─── メニュー ─────────────────────────────────────────────────────────
echo  利用可能なURL:
echo    ポータル  → http://localhost:3000/portal/
echo    ⚡ LOBBY  → http://localhost:3000/lobby/
echo    ワークスペ → http://localhost:3000/workspace/
echo    プロバイダ → http://localhost:3000/provider/
echo    管理画面  → http://localhost:3000/admin/
echo.
echo ─────────────────────────────────────────────────────────────
echo   [1] サーバーのみ起動
echo   [2] サーバー + Cloudflare Tunnel (外部公開) 起動
echo   [3] DBマイグレーション実行 (初回/SF統合時)
echo   [4] セットアップ実行
echo   [5] 終了
echo.
choice /c 12345 /m "選択してください: "

if errorlevel 5 goto :eof
if errorlevel 4 call setup.bat && goto :eof
if errorlevel 3 goto :run_migrate
if errorlevel 2 goto :start_with_tunnel
if errorlevel 1 goto :start_server

:run_migrate
echo.
echo [INFO] SF カラムマイグレーションを実行中...
node scripts/migrate_sf_columns.js
if %errorlevel% neq 0 (
    echo [ERROR] マイグレーションに失敗しました。
    pause
    exit /b 1
)
echo.
echo [OK] マイグレーション完了。サーバーを起動しますか？
choice /c YN /m "起動しますか？"
if errorlevel 2 goto :eof
goto :start_server

:start_server
echo.
echo [INFO] サーバーを起動中...
echo [INFO] Ctrl+C で停止できます
echo.
node server/index.js
goto :eof

:start_with_tunnel
echo.
echo [INFO] サーバーとCloudflare Tunnelを起動中...
echo.

:: cloudflared チェック
where cloudflared >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] cloudflared が未インストールです。
    echo        winget install Cloudflare.cloudflared を実行してください。
    echo        サーバーのみ起動します。
    echo.
    goto :start_server
)

:: サーバーをバックグラウンドで起動
start "GPU Rental Server" cmd /k "node server/index.js"
timeout /t 3 /nobreak >nul

echo.
echo ══════════════════════════════════════════════════════════════
echo   サーバー起動完了！ Cloudflare Tunnel を開始します...
echo   表示された https://*.trycloudflare.com を共有してください
echo.
echo   ⚡ SF 関連URL:
echo   [URL]/lobby/              THE LOBBY
echo   [URL]/workspace/?raid_job=ID   レイドジョブ追跡
echo ══════════════════════════════════════════════════════════════
echo.

:: Named Tunnel or Quick Tunnel
for /f "usebackq tokens=1,2 delims==" %%A in (".env") do (
    if "%%A"=="CLOUDFLARE_TUNNEL_TOKEN" set CF_TOKEN=%%B
)

if defined CF_TOKEN (
    echo [INFO] Named Tunnel (CLOUDFLARE_TUNNEL_TOKEN) で起動します
    cloudflared tunnel --token %CF_TOKEN% run
) else (
    cloudflared tunnel --url http://localhost:3000
)
goto :eof
