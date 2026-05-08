@echo off
chcp 65001 >nul
title Codex DeepSeek 中转脚本
cd /d "%~dp0"

echo ========================================
echo Codex / cc switch - DeepSeek 中转脚本
echo ========================================
echo.

if exist "%~dp0api-key.txt" (
  set /p DEEPSEEK_KEY=<"%~dp0api-key.txt"
  echo 已从 api-key.txt 读取 DeepSeek API Key。
) else (
  echo 未找到 api-key.txt，稍后可在可视化页面里填写。
  set DEEPSEEK_KEY=
)

echo.
echo 正在启动中转服务...
echo.
echo 可视化页面：
echo http://127.0.0.1:8787/
echo.
echo cc switch / Codex 配置请使用：
echo base_url = http://127.0.0.1:8787/v1
echo model    = deepseek-v4-pro
echo api_key  = local-proxy-key
echo.
echo 注意：窗口不要关闭，关闭后中转服务会停止。
echo.

start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787/'"
powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0start-bridge.ps1' -ApiKey $env:DEEPSEEK_KEY -Model 'deepseek-v4-pro'"

echo.
echo 中转服务已停止。
pause
