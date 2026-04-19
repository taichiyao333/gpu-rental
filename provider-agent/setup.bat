@echo off
chcp 65001 >nul
setlocal ENABLEDELAYEDEXPANSION

:: ═══════════════════════════════════════════════════════════════
::  THE DOJO — GPU Street Fighter エージェント セットアップ v2.0
::  GPURental Platform
:: ═══════════════════════════════════════════════════════════════

title THE DOJO Setup — GPU Street Fighter Agent v2.0

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║    ⚔  THE DOJO — GPU SF Agent Setup v2.0  ⚔       ║
echo  ║        GPURental Platform — THE REFEREE             ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

:: ── 管理者権限チェック ──────────────────────────────────────────
net session >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [WARN] 管理者権限がありません。右クリック → 「管理者として実行」を推奨します。
    echo.
)

:: ── Node.js チェック ─────────────────────────────────────────────
echo  [1/6] Node.js チェック中...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Node.js が見つかりません。
    echo          https://nodejs.org からインストールしてください。
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK]   Node.js !NODE_VER! 検出

:: ── GPU チェック ──────────────────────────────────────────────────
echo.
echo  [2/6] NVIDIA GPU チェック中...
where nvidia-smi >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [WARN] nvidia-smi が見つかりません。GPUなし/CPU環境として動作します。
    set GPU_AVAILABLE=false
) else (
    echo  ── 検出されたGPU ──────────────────────────────────
    nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>nul
    echo  ────────────────────────────────────────────────────
    set GPU_AVAILABLE=true
)

:: ── 依存パッケージインストール ───────────────────────────────────
echo.
echo  [3/6] 依存パッケージインストール中...
cd /d "%~dp0"

if not exist "package.json" (
    echo  package.json が見つかりません。npmを初期化中...
    npm init -y >nul 2>&1
)

call npm install --production >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo  [OK]   npm install --production 完了
) else (
    echo  [WARN] npm install に失敗しました。手動で実行してください: npm install
)

:: ── 設定入力 ─────────────────────────────────────────────────────
echo.
echo  [4/6] エージェント設定...
echo.
echo  ※ プロバイダーダッシュボード (GPURental) でトークンを取得してください
echo.

set /p PLATFORM_URL="  GPURental サーバーURL (例: https://gpurental.jp) [http://localhost:3000] : "
if "!PLATFORM_URL!"=="" set PLATFORM_URL=http://localhost:3000

set /p AGENT_TOKEN="  エージェントトークン (JWTトークン) : "
if "!AGENT_TOKEN!"=="" (
    echo  [WARN] トークンが未入力です。後で config.json を編集してください。
    set AGENT_TOKEN=YOUR_TOKEN_HERE
)

set /p LOCATION="  設置場所 (例: 東京, 大阪, 名古屋) [東京] : "
if "!LOCATION!"=="" set LOCATION=東京

set /p PRICE="  希望時間単価 (円) [1200] : "
if "!PRICE!"=="" set PRICE=1200

set /p HB_INTERVAL="  ハートビート送信間隔 (秒) [30] : "
if "!HB_INTERVAL!"=="" set HB_INTERVAL=30

:: config.json 生成 ──────────────────────────────────────────────
(
echo {
echo   "platformUrl": "!PLATFORM_URL!",
echo   "token": "!AGENT_TOKEN!",
echo   "location": "!LOCATION!",
echo   "pricePerHour": !PRICE!,
echo   "heartbeatIntervalSec": !HB_INTERVAL!,
echo   "benchmarkOnStart": true,
echo   "autoRestart": true,
echo   "logLevel": "info"
echo }
) > config.json

echo  [OK]   config.json を生成しました

:: ── SSH セットアップ ────────────────────────────────────────────
echo.
echo  [5/6] SSHサーバーのセットアップ...
if exist "scripts\setup-ssh.ps1" (
    powershell -ExecutionPolicy Bypass -File "%~dp0scripts\setup-ssh.ps1" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        echo  [OK]   SSHサーバー設定完了
    ) else (
        echo  [WARN] SSHサーバーの自動設定に失敗。手動でセットアップが必要な場合があります。
    )
) else (
    echo  [SKIP] setup-ssh.ps1 が見つかりません
)

:: ── スタートアップ登録 ──────────────────────────────────────────
echo.
echo  [6/6] 自動起動設定...
set /p STARTUP="  Windowsスタートアップに登録しますか？(y/n) [y] : "
if /i "!STARTUP!"=="" set STARTUP=y

if /i "!STARTUP!"=="y" (
    set TASK_NAME=GPURental-TheDojo
    set SCRIPT_PATH=%~dp0index.js
    schtasks /query /tn "!TASK_NAME!" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        schtasks /delete /tn "!TASK_NAME!" /f >nul 2>&1
    )
    schtasks /create /tn "!TASK_NAME!" ^
        /tr "node \"!SCRIPT_PATH!\"" ^
        /sc ONLOGON ^
        /ru "%USERNAME%" ^
        /f >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        echo  [OK]   タスクスケジューラに「!TASK_NAME!」を登録しました
    ) else (
        echo  [WARN] タスクスケジューラへの登録に失敗しました
    )
) else (
    echo  [SKIP] 自動起動は登録しません
)

:: ── start.bat 生成 ───────────────────────────────────────────────
(
echo @echo off
echo chcp 65001 ^>nul
echo title THE DOJO — GPU SF Agent
echo cd /d "%%~dp0"
echo echo.
echo echo  ⚔ THE DOJO エージェント起動中...
echo echo  Ctrl+C で停止
echo echo.
echo :loop
echo node index.js 2^>^&1 ^| tee agent.log
echo echo [RESTART] 5秒後に再起動します...
echo timeout /t 5 ^>nul
echo goto loop
) > start.bat

:: ── 完了 ─────────────────────────────────────────────────────────
echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║  ✅ セットアップ完了！                               ║
echo  ║                                                      ║
echo  ║  起動方法:                                           ║
echo  ║    ・start.bat をダブルクリック (推奨)               ║
echo  ║    ・または: node index.js                           ║
echo  ║                                                      ║
echo  ║  設定変更:  config.json を編集してください           ║
echo  ║  ログ確認:  agent.log を参照してください             ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
echo  [生成ファイル]
echo    config.json  ← エージェント設定 (トークン等)
echo    start.bat    ← 起動スクリプト (自動再起動付き)
echo.

set /p START_NOW="  今すぐエージェントを起動しますか？(y/n) [y] : "
if /i "!START_NOW!"=="" set START_NOW=y
if /i "!START_NOW!"=="y" (
    echo.
    echo  ⚔ THE DOJO エージェントを起動します...
    start "THE DOJO Agent" cmd /k "node index.js 2>&1 | tee agent.log"
)

echo.
pause
endlocal
