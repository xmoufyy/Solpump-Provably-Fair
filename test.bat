@echo off
rem Runs every quality gate: types, lint, unit + parity, independent Python parity,
rem integration, build, browser tests and npm audit. Writes docs\AUDIT_RESULTS.txt.
cd /d "%~dp0"
if not exist node_modules call npm install
call npm exec -w frontend -- playwright install chromium
call npm run audit:all
exit /b %errorlevel%
