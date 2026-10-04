@echo off
rem Learn Hub launcher — double-click to start the app and open it in your browser.
cd /d "%~dp0"
echo Starting Learn Hub...
node --no-warnings server.js
pause
