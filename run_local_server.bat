@echo off
echo ========================================================
echo Starting LeanLife Wellness Local Server (Native Windows)...
echo ========================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0local_server.ps1"
pause
