@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Capcraft Editor - Instalacion
echo ============================================
echo   Capcraft Editor - Instalacion
echo ============================================
echo.
set FALTA=0

where python >nul 2>nul
if errorlevel 1 (
  echo - Instalando Python 3.12...
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  set FALTA=1
) else ( echo [OK] Python )

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo - Instalando FFmpeg...
  winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
  set FALTA=1
) else ( echo [OK] FFmpeg )

where npm >nul 2>nul
if errorlevel 1 (
  echo - Instalando Node.js LTS...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  set FALTA=1
) else ( echo [OK] Node.js )

if "%FALTA%"=="1" (
  echo.
  echo Se instalaron programas nuevos. CIERRA esta ventana y vuelve a abrir instalar.bat
  pause
  exit /b
)

echo.
echo [1/3] Motor de subtitulos (Python)...
if not exist engine\.venv python -m venv engine\.venv
call engine\.venv\Scripts\activate.bat
python -m pip install --upgrade pip >nul
pip install -r engine\requirements.txt
if errorlevel 1 goto :error
call deactivate

echo.
echo [2/3] Aplicacion de escritorio (Electron, ~100 MB)...
pushd app
call npm install --no-audit --no-fund
if errorlevel 1 ( popd & goto :error )
rem npm nuevo no ejecuta los scripts de instalacion: se descarga Electron explicitamente
if not exist node_modules\electron\dist\electron.exe (
  echo Descargando Electron...
  node node_modules\electron\install.js
)
if not exist node_modules\electron\dist\electron.exe ( popd & echo No se pudo descargar Electron. & goto :error )
popd

echo.
echo [3/3] Creando acceso directo en el escritorio...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Capcraft Editor.lnk'));" ^
  "$s.TargetPath='%~dp0app\node_modules\electron\dist\electron.exe'; $s.Arguments='\"%~dp0app\"';" ^
  "$s.WorkingDirectory='%~dp0app'; $s.IconLocation='%~dp0app\icon.ico'; $s.Description='Capcraft Editor'; $s.Save()"

echo.
echo ============================================
echo   LISTO. Abre "Capcraft Editor" desde el
echo   escritorio (o con Capcraft Editor.bat).
echo ============================================
pause
exit /b 0

:error
echo.
echo ERROR durante la instalacion. Copia el texto de arriba y pasaselo a Claude.
pause
exit /b 1
