@echo off
chcp 65001 >nul
title 验证 DeepSeek 中转真实链路
cd /d "%~dp0"

echo ========================================
echo 验证真实 DeepSeek 链路
echo ========================================
echo.

if exist "%~dp0api-key.txt" (
  set /p DEEPSEEK_KEY=<"%~dp0api-key.txt"
  echo 已从 api-key.txt 读取 DeepSeek API Key。
) else (
  echo 请粘贴你的 DeepSeek API Key，然后回车。
  set /p DEEPSEEK_KEY=DeepSeek API Key: 
)

if "%DEEPSEEK_KEY%"=="" (
  echo.
  echo 未读取到 API Key，已取消验证。
  pause
  exit /b 1
)

echo 该脚本会自动启动临时中转服务，测试 JSON 和 Stream，完成后自动关闭。
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0verify-real.ps1' -ApiKey $env:DEEPSEEK_KEY -Model 'deepseek-v4-pro'"

echo.
pause
