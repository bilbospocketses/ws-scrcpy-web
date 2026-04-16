@echo off
:: ws-scrcpy-web launcher for Windows
:: Runs Node.js from dependencies folder, handles restart on update

setlocal

set "SCRIPT_DIR=%~dp0"
set "NODE=%SCRIPT_DIR%dependencies\node\node.exe"
set "ENTRY=%SCRIPT_DIR%dist\index.js"
set "RESTART_MARKER=%SCRIPT_DIR%.restart"
set "DEPS_PATH=%SCRIPT_DIR%dependencies"

:: Ensure node binary exists
if not exist "%NODE%" (
    echo ERROR: Node.js not found at %NODE%
    echo Run the initial setup or place node.exe in dependencies\node\
    pause
    exit /b 1
)

:: Set environment so the app knows where dependencies live
set "DEPS_PATH=%DEPS_PATH%"

:: Clean up stale restart marker
if exist "%RESTART_MARKER%" del "%RESTART_MARKER%"

:: Clean up old node binary from previous update
if exist "%NODE%.old" del "%NODE%.old"

:loop
echo Starting ws-scrcpy-web...
"%NODE%" "%ENTRY%"
set "EXIT_CODE=%ERRORLEVEL%"

:: Check if restart was requested
if exist "%RESTART_MARKER%" (
    del "%RESTART_MARKER%"
    :: Clean up old node binary if update just happened
    if exist "%NODE%.old" del "%NODE%.old"
    echo Restarting...
    timeout /t 2 /nobreak >nul
    goto loop
)

:: Process exited without restart request — stop
echo ws-scrcpy-web exited with code %EXIT_CODE%
exit /b %EXIT_CODE%
