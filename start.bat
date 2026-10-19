@echo off
setlocal
title Solpump Fairness Lab
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 22.13 or newer from https://nodejs.org
  pause
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22.13 or newer is required ^(built-in SQLite^). Found:
  node -v
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

echo Building the user interface...
call npm run build -w frontend
if errorlevel 1 goto :fail

if "%PORT%"=="" set PORT=8787
echo.
echo Solpump Fairness Lab will open at http://localhost:%PORT%
echo Audit history is stored in data\fairness-lab.db
echo Press Ctrl+C in this window to stop.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT%"
call npm start
goto :eof

:fail
echo.
echo [ERROR] Startup failed - see the messages above.
pause
exit /b 1
