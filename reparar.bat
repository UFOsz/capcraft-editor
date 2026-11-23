@echo off
chcp 65001 >nul
cd /d "%~dp0app"
title Capcraft Editor - Reparar
echo Descargando Electron (unos 100 MB)...
if not exist node_modules\electron\install.js call npm install --no-audit --no-fund
node node_modules\electron\install.js
if not exist node_modules\electron\dist\electron.exe (
  echo.
  echo No se pudo descargar Electron. Copia el texto de arriba y pasaselo a Claude.
  pause
  exit /b 1
)
echo.
echo LISTO. Ya puedes abrir Capcraft Editor desde el escritorio.
pause
