@echo off
REM RedTrace Windows deployment wrapper
REM Run this script to start the deployment

echo Starting RedTrace deployment on Windows...
powershell -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*

if %ERRORLEVEL% NEQ 0 (
    echo Deployment failed with error code %ERRORLEVEL%
    pause
    exit /b %ERRORLEVEL%
)

echo Deployment completed successfully!
pause
