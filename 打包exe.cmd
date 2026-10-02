@echo off
rem ============================================================
rem  Deepseek Harness - one-click packager
rem  Builds Setup (installer) + Portable exe into dist\
rem  (ASCII only on purpose: cmd.exe must not mis-parse this file)
rem ============================================================
cd /d "%~dp0"

if not exist "node_modules\electron-builder" (
  echo [Deepseek Harness] First run: installing build dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo [Deepseek Harness] Install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

echo [Deepseek Harness] Building...
echo.

node "node_modules\electron-builder\cli.js" --win --x64 --publish never

if errorlevel 1 (
  echo.
  echo [Deepseek Harness] Build failed. See the errors above.
  pause
  exit /b 1
)

echo.
echo [Deepseek Harness] Done! Artifacts are in dist:
echo   - Deepseek Harness-Setup-*.exe      installer (recommended)
echo   - Deepseek Harness-Portable-*.exe   portable (no install)
pause
