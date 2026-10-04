@echo off
rem Remove the Learn Hub daily refresh scheduled task.
schtasks /delete /tn "LearnHub Daily Refresh" /f
echo.
pause
