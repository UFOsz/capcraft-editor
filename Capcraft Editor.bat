@echo off
cd /d "%~dp0"
if not exist app\node_modules\electron\dist\electron.exe (
  echo Primero ejecuta instalar.bat
  pause
  exit /b
)
start "" "app\node_modules\electron\dist\electron.exe" "app"
