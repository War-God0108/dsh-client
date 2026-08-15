@echo off
rem ============================================================
rem  DSH CLIENT - 一键打包脚本
rem  生成安装器 (Setup) + 便携版 (Portable)
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\electron-builder" (
  echo [DSH CLIENT] 首次运行，正在安装打包依赖…
  call npm install
  if errorlevel 1 (
    echo.
    echo [DSH CLIENT] 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo [DSH CLIENT] 开始打包…
echo.

node "node_modules\electron-builder\cli.js" --win --x64 --publish never

if errorlevel 1 (
  echo.
  echo [DSH CLIENT] 打包失败，请查看上方错误信息。
  pause
  exit /b 1
)

echo.
echo [DSH CLIENT] 打包完成！产物在 dist 目录：
echo   - DSH CLIENT-Setup-*.exe      安装器（推荐）
echo   - DSH CLIENT-Portable-*.exe   便携版（免安装，双击即用）
pause
