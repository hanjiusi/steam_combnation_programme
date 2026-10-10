@echo off
rem ============================================================
rem  Steam Recommendation Demo - one-click launcher
rem  (SteamTasteAtlas profile x bigdata_steam NSGA-II reco)
rem  Double-click this file. Keep the window open while demoing.
rem ============================================================
cd /d "%~dp0"
setlocal
title Steam Demo Server (http://127.0.0.1:4319/)

if exist "%~dp0tools\windows-node\node.exe" (
  set "COMBO_NODE=%~dp0tools\windows-node\node.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Node.js not found. Install Node.js 22+ or restore tools\windows-node\node.exe
    pause
    exit /b 1
  )
  set "COMBO_NODE=node"
)

rem --- already running? ---
"%COMBO_NODE%" -e "fetch('http://127.0.0.1:4319/healthz',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>nul
if not errorlevel 1 (
  echo Demo server is already running. Opening the page ...
  start "" http://127.0.0.1:4319/
  exit /b 0
)

rem --- start server in this window, wait until ready, then open browser ---
echo Starting demo server on port 4319 ...
start "" /b "%COMBO_NODE%" server.mjs
"%COMBO_NODE%" -e "const t=Date.now();(function p(){fetch('http://127.0.0.1:4319/healthz',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>{if(Date.now()-t>20000){process.exit(1)}setTimeout(p,300)})})();"
if errorlevel 1 (
  echo.
  echo [ERROR] Server not ready within 20 seconds. Check messages above, or run manually:
  echo   "%COMBO_NODE%" server.mjs
  pause
  exit /b 1
)

echo Demo ready: http://127.0.0.1:4319/
start "" http://127.0.0.1:4319/
echo.
echo Keep this window OPEN while presenting. Close it to stop the server.
pause