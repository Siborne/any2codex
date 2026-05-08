param(
  [Parameter(Mandatory = $true)]
  [string]$ApiKey,
  [string]$Model = 'deepseek-v4-pro',
  [string]$BaseUrl = 'https://api.deepseek.com',
  [int]$Port = 8797,
  [string]$LocalApiKey = 'local-proxy-key'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Find-NodeExe {
  $candidates = @(
    (Join-Path $PSScriptRoot '..\runtime\node.exe'),
    (Join-Path $PSScriptRoot '..\node.exe'),
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

function Wait-BridgeReady {
  param([string]$Url)

  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "$Url/health" -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }

  throw "Bridge did not become ready in 20 seconds: $Url"
}

function Invoke-JsonPost {
  param(
    [string]$Url,
    [object]$Body
  )

  $jsonBody = $Body | ConvertTo-Json -Depth 20
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Method Post `
      -Uri $Url `
      -Headers @{ Authorization = "Bearer $LocalApiKey" } `
      -ContentType 'application/json' `
      -Body $jsonBody `
      -TimeoutSec 120
  } catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
    $errorBody = $reader.ReadToEnd()
    throw "POST $Url failed: HTTP $statusCode $errorBody"
  }

  return $response.Content | ConvertFrom-Json
}

$nodeExe = Find-NodeExe
$env:DEEPSEEK_API_KEY = $ApiKey
$env:DEEPSEEK_MODEL = $Model
$env:DEEPSEEK_BASE_URL = $BaseUrl
$env:HOST = '127.0.0.1'
$env:PORT = [string]$Port
$env:LOCAL_API_KEY = $LocalApiKey
$env:MOCK_MODE = '0'

$base = "http://127.0.0.1:$Port"
$proc = Start-Process -FilePath $nodeExe -ArgumentList "$PSScriptRoot\..\src\server.mjs" -PassThru

try {
  Wait-BridgeReady -Url $base

  Write-Host "OK: bridge started: $base" -ForegroundColor Green
  Write-Host "Node: $nodeExe" -ForegroundColor Cyan

  $normal = Invoke-JsonPost -Url "$base/v1/responses" -Body @{
    model = $Model
    input = 'Please reply only: ok'
    stream = $false
  }

  if ($normal.object -ne 'response' -or $normal.status -ne 'completed') {
    throw "JSON Responses test failed: $($normal | ConvertTo-Json -Depth 20)"
  }

  Write-Host "OK: real DeepSeek JSON request passed" -ForegroundColor Green

  $streamBody = @{
    model = $Model
    input = 'Reply with one short sentence for stream test'
    stream = $true
  } | ConvertTo-Json -Depth 20

  $stream = Invoke-WebRequest `
    -UseBasicParsing `
    -Method Post `
    -Uri "$base/v1/responses" `
    -Headers @{ Authorization = "Bearer $LocalApiKey" } `
    -ContentType 'application/json' `
    -Body $streamBody `
    -TimeoutSec 120

  if ($stream.Content -notmatch 'response.completed' -or $stream.Content -notmatch '\[DONE\]') {
    throw "Stream Responses test failed: $($stream.Content)"
  }

  Write-Host "OK: real DeepSeek Stream request passed" -ForegroundColor Green

  $tool = Invoke-JsonPost -Url "$base/v1/responses" -Body @{
    model = $Model
    input = 'Call the search_docs tool with query mock.'
    stream = $false
    tools = @(
      @{
        type = 'function'
        name = 'search_docs'
        description = 'Search documents'
        parameters = @{
          type = 'object'
          properties = @{
            query = @{ type = 'string' }
          }
          required = @('query')
        }
      }
    )
    tool_choice = 'required'
  }

  $toolCall = @($tool.output | Where-Object { $_.type -eq 'function_call' } | Select-Object -First 1)[0]
  if (-not $toolCall -or $toolCall.name -ne 'search_docs' -or [string]::IsNullOrWhiteSpace($toolCall.call_id)) {
    throw "Tool call test failed: $($tool | ConvertTo-Json -Depth 30)"
  }

  Write-Host "OK: real DeepSeek tool call request passed" -ForegroundColor Green

  $toolFollow = Invoke-JsonPost -Url "$base/v1/responses" -Body @{
    model = $Model
    previous_response_id = $tool.id
    input = @(
      @{
        type = 'function_call_output'
        call_id = $toolCall.call_id
        output = '{"result":"real tool ok"}'
      }
    )
  }

  if ($toolFollow.object -ne 'response' -or $toolFollow.status -ne 'completed') {
    throw "Tool continuation test failed: $($toolFollow | ConvertTo-Json -Depth 30)"
  }

  Write-Host "OK: real DeepSeek tool continuation request passed" -ForegroundColor Green

  $toolFollowWithoutPrevious = Invoke-JsonPost -Url "$base/v1/responses" -Body @{
    model = $Model
    input = @(
      @{
        type = 'function_call_output'
        call_id = $toolCall.call_id
        output = '{"result":"real tool ok without previous"}'
      }
    )
  }

  if ($toolFollowWithoutPrevious.object -ne 'response' -or $toolFollowWithoutPrevious.status -ne 'completed') {
    throw "Tool continuation without previous_response_id test failed: $($toolFollowWithoutPrevious | ConvertTo-Json -Depth 30)"
  }

  Write-Host "OK: real DeepSeek tool continuation without previous_response_id passed" -ForegroundColor Green

  $danglingToolHistory = Invoke-JsonPost -Url "$base/v1/responses" -Body @{
    model = $Model
    previous_response_id = $tool.id
    input = 'Continue even if the previous tool call has no tool output.'
  }

  if ($danglingToolHistory.object -ne 'response' -or $danglingToolHistory.status -ne 'completed') {
    throw "Dangling tool history test failed: $($danglingToolHistory | ConvertTo-Json -Depth 30)"
  }

  Write-Host "OK: real DeepSeek dangling tool history auto-repair passed" -ForegroundColor Green
  Write-Host "Done. Configure cc switch/Codex: base_url=http://127.0.0.1:8787/v1 model=$Model api_key=$LocalApiKey" -ForegroundColor Cyan
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
