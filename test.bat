@echo off
rem Runs unit, parity and integration tests (Vitest), then browser tests (Playwright).
cd /d "%~dp0"
if not exist node_modules call npm install
call npm test
if errorlevel 1 exit /b 1
call npm exec -w frontend -- playwright install chromium
call npm run test:e2e
