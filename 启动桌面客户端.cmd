@echo off
rem ============================================================
rem  Deepseek Harness - desktop client launcher
rem  Double-click this file to open the client window.
rem  (ASCII only on purpose: cmd.exe must not mis-parse this file)
rem ============================================================
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Deepseek Harness] First run: installing dependencies - about 1 to 2 minutes...  
  call npm install
  if errorlevel 1 (
    echo.
    echo [Deepseek Harness] Install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

echo [Deepseek Harness] Starting desktop client...
echo [Deepseek Harness] The app starts its own DSH host when none is running.
echo.

node "node_modules\electron\cli.js" .
if errorlevel 1 (
  echo.
  echo [Deepseek Harness] Start failed, or the window was closed.
  pause
)
