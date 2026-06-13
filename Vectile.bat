@echo off
rem ============================================================
rem  Vectile launcher (Windows)
rem  Double-click to start. Installs uv on first run, then
rem  uses uv to install Python deps and launch the app.
rem ============================================================
setlocal
cd /d "%~dp0"

where uv >nul 2>&1
if errorlevel 1 (
    echo Installing uv (Astral Python launcher)...
    powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://astral.sh/uv/install.ps1 | iex"
    if errorlevel 1 (
        echo.
        echo Failed to install uv. See https://astral.sh/uv for manual install.
        pause
        exit /b 1
    )
    set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)

echo Starting Vectile...
uv run vectile
if errorlevel 1 (
    echo.
    echo Vectile exited with an error.
    pause
)
endlocal
