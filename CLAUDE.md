# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a **zero-dependency Node.js bridge** that translates OpenAI `Responses API` calls (used by Codex / cc switch) into DeepSeek `chat/completions` requests. It runs as a local HTTP proxy on `127.0.0.1:8787` and requires **no `npm install`**.

## Commands

```bash
# Run the server (requires DeepSeek API key set via env or api-key.txt)
node server.mjs

# Run in mock mode (no API key needed — all responses are simulated)
$env:MOCK_MODE='1'; node server.mjs

# Full self-test suite (spawns server in mock mode, runs smoke-test.mjs)
npm test

# Smoke tests only (requires a running bridge server)
npm run smoke

# Real-API verification (PowerShell, requires a real DeepSeek key)
.\verify-real.ps1 -ApiKey "sk-..."
```

## Architecture

The entire bridge lives in a single file: **`server.mjs`** (~1300 lines). There is no framework, no routing library — it uses Node's built-in `http` module directly.

### Request flow

1. Client (Codex/cc switch) sends `POST /v1/responses` (OpenAI Responses API format) to the bridge
2. `buildMessagesFromInput()` converts the Responses-format `input` array into DeepSeek chat/completions message format
3. `sanitizeMessagesForChatCompletions()` ensures tool call message ordering is valid (assistant tool_calls → tool responses paired correctly)
4. `fetchDeepSeek()` sends the converted payload to `DEEPSEEK_BASE_URL/chat/completions`
5. Response is converted back to Responses API format via `buildResponseObject()`

### Key design decisions

- **`store` Map** — holds response history keyed by `response_id`. This enables `previous_response_id` continuation (the bridge reconstructs prior conversation context from its own store, not from the client).
- **`toolCallMessageStore` Map** — remembers the original assistant message for each `tool_call_id`. When a `function_call_output` arrives later (possibly without the preceding assistant message), the bridge can reconstruct it.
- **Message sanitization** — DeepSeek chat/completions has stricter requirements than Responses API about tool message ordering. `sanitizeMessagesForChatCompletions()` handles: skipping orphaned tool_calls messages, skipping duplicate tool_calls, injecting synthetic tool results for missing ones.
- **SSE streaming** — `parseSseJsonStream()` is a manual SSE parser. The bridge streams chunks from DeepSeek's SSE response and re-emits them as Responses API SSE events (different event types).

### API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` or `/admin` | HTML admin page (set API key, test connection) |
| `GET`/`POST` | `/admin/config` | Read/save DeepSeek API key |
| `POST` | `/admin/test` | Test real DeepSeek connection |
| `GET` | `/health` | Health check + config info |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/responses` | Main bridge endpoint (JSON or SSE stream) |
| `GET` | `/v1/responses/:id` | Retrieve stored response |
| `DELETE` | `/v1/responses/:id` | Delete stored response |

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEEPSEEK_API_KEY` | (from `api-key.txt`) | DeepSeek API key |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | Model name sent to DeepSeek |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Upstream base URL |
| `HOST` | `127.0.0.1` | Listen host |
| `PORT` | `8787` | Listen port |
| `LOCAL_API_KEY` | `local-proxy-key` | Auth token clients must send |
| `MOCK_MODE` | `false` | If `1`/`true`/`yes`, returns mock responses without calling DeepSeek |
| `MAX_HISTORY` | `200` | Max stored responses |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout |

### Test architecture

- **`test-bridge.mjs`** — integration test runner. Spawns `server.mjs` as a child process with `MOCK_MODE=1`, waits for `/health`, then runs `smoke-test.mjs` as a subprocess. Cleans up on exit.
- **`smoke-test.mjs`** — the actual test suite. Covers: health, auth failure, models, JSON responses, response retrieve, `previous_response_id` continuation, tool call conversion, tool call continuation (with and without `previous_response_id`), dangling tool history repair, SSE stream text, SSE stream tool calls. All tests run against mock mode.
- **`verify-real.ps1`** — PowerShell script that starts the bridge with a real API key and runs the same tests against the real DeepSeek API, then kills the server.

### Startup scripts

- **`start-bridge.ps1`** — finds Node.js (checks `runtime\node.exe`, `node.exe`, system PATH), sets env vars, runs `server.mjs`
- **`启动中转脚本.cmd`** — CMD wrapper that reads `api-key.txt` into env, launches the PS script, and auto-opens the admin page in browser
- **`bootstrap.cmd`** — copies the entire project to `%LOCALAPPDATA%\DeepSeekBridge` for a persistent installation

### API key persistence

The admin page at `/` saves the API key via `POST /admin/config`, which writes to `api-key.txt` in the script directory. On startup, `server.mjs` reads from `api-key.txt` if `DEEPSEEK_API_KEY` env var is not set.
