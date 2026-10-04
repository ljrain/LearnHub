@echo off
rem Learn Hub (synced) — share your reading status, stats, and plans across
rem computers by keeping the data in a cloud-synced folder (OneDrive/Dropbox).
rem
rem   IMPORTANT: run Learn Hub on only ONE machine at a time. Close it and let
rem   your cloud drive finish syncing before opening it on the other machine.
rem
rem Edit the folder below if you don't use OneDrive, or want a different location.
rem Use the SAME folder on both computers. %OneDrive% is set by Windows for you.
set "LEARNHUB_DATA_DIR=%OneDrive%\LearnHub"

cd /d "%~dp0"
echo Starting Learn Hub (synced data: %LEARNHUB_DATA_DIR%)...
node --no-warnings server.js
pause
