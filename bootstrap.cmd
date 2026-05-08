@echo off
chcp 65001 >nul
set "APPDIR=%LOCALAPPDATA%\DeepSeekBridge"
if not exist "%APPDIR%" mkdir "%APPDIR%"
xcopy "%~dp0*" "%APPDIR%\" /E /I /Y >nul
start "DeepSeek Visual Bridge" "%APPDIR%\启动中转脚本.cmd"
exit /b 0
