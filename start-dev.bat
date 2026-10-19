@echo off
rem Development mode: API on :8787 with reload, Vite UI with hot reload on http://localhost:5173
cd /d "%~dp0"
if not exist node_modules call npm install
start "" cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:5173"
call npm run dev
