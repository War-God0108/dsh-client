@echo off
rem ============================================================
rem  Deepseek Harness - 桌面客户端 启动脚本
rem  双击本文件即可打开客户端窗口
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Deepseek Harness] 首次运行，正在安装依赖（约 1-2 分钟）…
  call npm install
  if errorlevel 1 (
    echo.
    echo [Deepseek Harness] 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo [Deepseek Harness] 正在启动桌面客户端…
echo [Deepseek Harness] 请确保 DeepSeek Harness 正在 127.0.0.1:3080 运行
echo.

node "node_modules\electron\cli.js" .
if errorlevel 1 (
  echo.
  echo [Deepseek Harness] 启动失败，或窗口已被关闭。
  pause
)
