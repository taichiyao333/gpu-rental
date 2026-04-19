@echo off
:: GPURental PM2 Auto-Start on Windows Login
:: Registered as Task Scheduler task: GPURental_PM2_AutoStart
chcp 65001 > nul
title GPURental PM2 Startup

set PM2=C:\Users\taich\AppData\Roaming\npm\pm2.cmd
set LOG_DIR=F:\antigravity\gpu-platform\logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo [%date% %time%] PM2 Resurrect starting... >> "%LOG_DIR%\pm2_startup.log"

:: PM2 が既に起動していたら何もしない
"%PM2%" list 2>&1 | findstr "gpu-rental" | findstr "online" > nul
if %ERRORLEVEL% == 0 (
    echo [%date% %time%] PM2 already running - skip. >> "%LOG_DIR%\pm2_startup.log"
    goto :done
)

:: 保存済みプロセスリストを復元
"%PM2%" resurrect 2>> "%LOG_DIR%\pm2_startup.log"
echo [%date% %time%] PM2 resurrect done. >> "%LOG_DIR%\pm2_startup.log"

:: 3秒待ってから状態確認
timeout /t 3 /nobreak > nul
"%PM2%" list >> "%LOG_DIR%\pm2_startup.log"
echo [%date% %time%] GPURental PM2 startup complete. >> "%LOG_DIR%\pm2_startup.log"

:done
exit /b 0
