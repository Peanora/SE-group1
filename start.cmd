@echo off
setlocal
cd /d "%~dp0"
set "TASKFLOW_BOOTSTRAP=node"
where node >nul 2>nul
if errorlevel 1 set "TASKFLOW_BOOTSTRAP=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if defined TASKFLOW_NODE set "TASKFLOW_BOOTSTRAP=%TASKFLOW_NODE%"
"%TASKFLOW_BOOTSTRAP%" scripts\start-local.mjs %*
if errorlevel 1 pause
