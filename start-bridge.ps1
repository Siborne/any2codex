param(
  [string]$ApiKey,
  [string]$Model = 'deepseek-v4-pro',
  [string]$BaseUrl = 'https://api.deepseek.com',
  [string]$ListenHost = '127.0.0.1',
  [int]$Port = 8787,
  [string]$LocalApiKey = 'local-proxy-key',
  [switch]$MockMode
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Find-NodeExe {
  $candidates = @(
    (Join-Path $PSScriptRoot 'runtime\node.exe'),
    (Join-Path $PSScriptRoot 'node.exe'),
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }

  throw 'Node.js was not found. Please keep runtime\node.exe in this folder, or install Node.js 18+.'
}

if (-not $MockMode -and [string]::IsNullOrWhiteSpace($ApiKey)) {
  throw 'Missing -ApiKey. Use -MockMode only for local mock testing.'
}

$nodeExe = Find-NodeExe
$env:DEEPSEEK_API_KEY = $ApiKey
$env:DEEPSEEK_MODEL = $Model
$env:DEEPSEEK_BASE_URL = $BaseUrl
$env:HOST = $ListenHost
$env:PORT = [string]$Port
$env:LOCAL_API_KEY = $LocalApiKey
$env:MOCK_MODE = if ($MockMode) { '1' } else { '0' }

Write-Host "Bridge starting on http://$ListenHost`:$Port" -ForegroundColor Green
Write-Host "Node: $nodeExe" -ForegroundColor Cyan
Write-Host "Model: $Model" -ForegroundColor Cyan
Write-Host "Base URL for cc switch/Codex: http://$ListenHost`:$Port/v1" -ForegroundColor Cyan
Write-Host "Local API key for cc switch/Codex: $LocalApiKey" -ForegroundColor Cyan
Write-Host "Mock mode: $($MockMode.IsPresent)" -ForegroundColor Yellow
Write-Host "Keep this window open while using Codex." -ForegroundColor Yellow

& $nodeExe .\server.mjs
