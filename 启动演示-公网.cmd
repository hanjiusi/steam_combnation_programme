@echo off
rem ============================================================
rem  Steam Demo - PUBLIC access launcher
rem  (share the demo site to any device via Cloudflare Quick Tunnel)
rem
rem  Double-click this file. Keep the window open while demoing.
rem  Internet is required. The public URL appears in this window.
rem  This runs on a separate port (4320) and does not conflict
rem  with the normal local launcher (4319).
rem ============================================================
cd /d "%~dp0"
setlocal
title Steam Demo Server - PUBLIC (keep this window open)

set "PUBLIC_PORT=4320"
set "PORT=%PUBLIC_PORT%"
set "ALLOW_PUBLIC=1"
set "TUNNEL_TARGET=http://127.0.0.1:%PUBLIC_PORT%"

if exist "%~dp0tools\windows-node\node.exe" (
  set "COMBO_NODE=%~dp0tools\windows-node\node.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Node.js not found. Restore tools\windows-node\node.exe
    pause
    exit /b 1
  )
  set "COMBO_NODE=node"
)

if not exist "%~dp0tools\cloudflared.exe" (
  echo [ERROR] tools\cloudflared.exe is missing. It is required for public access.
  echo Get it from https://github.com/cloudflare/cloudflared/releases
  echo and save it as tools\cloudflared.exe
  pause
  exit /b 1
)

rem --- already running on the public port? ---
"%COMBO_NODE%" -e "fetch('http://127.0.0.1:%PUBLIC_PORT%/healthz',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>nul
if errorlevel 1 goto startserver

echo Demo server is already running on port %PUBLIC_PORT%.
goto serverready

:startserver
echo Starting demo server on port %PUBLIC_PORT% (public tunnel mode) ...
start "" /b "%COMBO_NODE%" server.mjs
"%COMBO_NODE%" -e "const t=Date.now();(function p(){fetch('http://127.0.0.1:%PUBLIC_PORT%/healthz',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>{if(Date.now()-t>20000){process.exit(1)}setTimeout(p,300)})})();"
if errorlevel 1 (
  echo.
  echo [ERROR] Server not ready within 20 seconds. Run manually to see the error:
  echo   "%COMBO_NODE%" server.mjs
  pause
  exit /b 1
)

:serverready
echo Local page : http://127.0.0.1:%PUBLIC_PORT%/
echo Public URL : waiting for the Cloudflare tunnel (a few seconds; internet required) ...
echo.
start "" http://127.0.0.1:%PUBLIC_PORT%/

"%COMBO_NODE%" "%~dp0tools\tunnel.mjs"

echo.
echo Tunnel stopped. The local server also stops when this window closes.
pause