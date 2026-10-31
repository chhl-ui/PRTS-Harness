@echo off
rem PRTS owner terminal launcher (machine-local paths).
rem Double-click this file, or run it from any terminal.
rem If your directories differ, edit the three lines below.

set "PRTS_DATA_ROOT=C:\prts-data"
set "PRTS_WORKSPACE=C:\prts-workspace"
set "PRTS_CONFIG=C:\prts-system\config\prts.yml"

if not exist "%PRTS_DATA_ROOT%\secrets\deepseek.key" (
  echo [!] Missing %PRTS_DATA_ROOT%\secrets\deepseek.key
  echo     It will still start, but model calls will fail.
  echo.
)

cd /d "C:\prts-system"
npm run chat

echo.
echo [prts] exited.
pause
