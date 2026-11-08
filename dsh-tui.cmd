@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [dsh-tui] Node.js not found. Install Node.js 18+ and add it to PATH.
  pause
  exit /b 1
)

node "%~dp0dsh-tui.mjs" --config "%~dp0dsh-tui.config.json" %*
set "CODE=%errorlevel%"
if not "%CODE%"=="0" (
  echo.
  echo [dsh-tui] exit code %CODE%
  pause
)
exit /b %CODE%
