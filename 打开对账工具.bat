@echo off
setlocal
set "TOOLDIR=%~dp0"
where powershell >nul 2>nul
if errorlevel 1 goto fallback
powershell -NoProfile -ExecutionPolicy Bypass -File "%TOOLDIR%serve.ps1"
if errorlevel 1 goto fallback
endlocal
exit /b
:fallback
start "" "%TOOLDIR%index.html"
endlocal
