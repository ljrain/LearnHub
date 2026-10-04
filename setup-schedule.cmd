@echo off
rem ============================================================
rem  Learn Hub - install a daily background refresh + notifier
rem  Creates a Windows Scheduled Task that runs every morning,
rem  pulls new Microsoft Learn articles, and shows a desktop
rem  notification when new ones land.
rem ============================================================
setlocal
set "DIR=%~dp0"
set "TASK=LearnHub Daily Refresh"
set "RUNTIME=08:00"
if not "%~1"=="" set "RUNTIME=%~1"

rem Resolve the full path to node.exe (Task Scheduler may not have user PATH).
set "NODEEXE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%I"
if not defined NODEEXE (
  echo ERROR: Node.js not found on PATH. Install Node 22+ or add it to PATH, then retry.
  pause & exit /b 1
)

if not exist "%DIR%data" mkdir "%DIR%data"

schtasks /create /tn "%TASK%" /sc DAILY /st %RUNTIME% /f /tr "cmd /c cd /d \"%DIR%\" && if not exist data mkdir data && \"%NODEEXE%\" --no-warnings notify-refresh.js >> data\refresh.log 2>&1"

if %errorlevel%==0 (
  echo.
  echo  Installed: "%TASK%" runs daily at %RUNTIME%.
  echo  - It refreshes all topics and notifies you of new articles.
  echo  - Change the time:  setup-schedule.cmd 07:30
  echo  - Remove it:        remove-schedule.cmd
  echo  - Log:              %DIR%data\refresh.log
) else (
  echo.
  echo  Could not create the task. Try running this file "as administrator".
)
echo.
pause
