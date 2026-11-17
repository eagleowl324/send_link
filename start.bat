@echo off
rem Windows: double-click this file to start the server. Close the window (or press Ctrl+C) to stop it.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node server.js
pause
