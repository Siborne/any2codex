<p align="center">
  <img src="https://img.shields.io/badge/any2codex-v1.1.0-7dd3fc?style=for-the-badge&logo=openai&logoColor=white" alt="Version">
  <img src="https://img.shields.io/badge/node-%3E%3D18-86efac?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-facc15?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows-38bdf8?style=for-the-badge&logo=windows&logoColor=white" alt="Platform">
</p>

<h1 align="center">any2codex</h1>

<p align="center"><strong>让 Codex / cc switch 无缝使用 DeepSeek 模型的本地中转桥接服务</strong></p>

<p align="center">
  <sub>零依赖 · 纯 Node.js · 一键启动 · 自带可视化面板 · 支持流式 SSE</sub>
</p>

---

## 解决的问题

Codex / cc switch 请求 `https://api.deepseek.com/v1/responses` 会返回 404，因为 DeepSeek 没有 `/v1/responses` 端点，只有 `/chat/completions`。

**any2codex** 在本机启动一个 HTTP 服务，将 OpenAI `Responses API` 格式的请求自动转换为 DeepSeek `chat/completions` 格式，无缝桥接。

```
Codex / cc switch          any2codex (127.0.0.1:8787)          DeepSeek API
     │                           │                                  │
     ├── POST /v1/responses ────►│                                  │
     │  (Responses API 格式)      ├── POST /chat/completions ──────►│
     │                           │  (转换后)                         │
     │                           │◄── SSE/JSON 响应 ────────────────┤
     │◄── Responses API 响应 ────│                                  │
```

---

## 快速开始（5 步上手）

### 第一步：配置 API Key

在项目文件夹下**新建 `api-key.txt`**，填入你的 DeepSeek API Key：

```
sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> 该文件已被 `.gitignore` 排除，clone 后需要自行创建。也可以启动后在可视化面板里填写保存。

### 第二步：查看使用说明

确认 `api-key.txt` 已配置好，阅读下面的 cc switch 配置说明。

### 第三步：配置 cc switch

```
base_url = http://127.0.0.1:8787/v1
model    = deepseek-v4-pro
api_key  = local-proxy-key
```

> base_url 和 api_key 固定不改，换模型只改 model 字段。

### 第四步：启动脚本

双击 **`启动中转脚本.cmd`**，窗口保持打开，浏览器会自动打开可视化面板。

### 第五步：启动 Codex

打开 Codex，点击 **high（高）** 中文模式，其余选项不要动，配置完后直接点启动即可使用。

---

## 可视化面板

启动后浏览器自动打开 `http://127.0.0.1:8787/`，可以：

- 查看/修改 DeepSeek API Key（保存后即时生效）
- 一键测试真实 DeepSeek 连接是否正常
- 查看当前连接配置信息

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEEPSEEK_API_KEY` | 从 `api-key.txt` 读取 | DeepSeek API Key |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | 模型名称 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 上游地址 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `LOCAL_API_KEY` | `local-proxy-key` | 本地鉴权密码 |
| `MOCK_MODE` | `false` | 设为 `1` 开启模拟模式 |
| `MAX_HISTORY` | `200` | 最大存储响应数 |
| `REQUEST_TIMEOUT_MS` | `120000` | 上游超时（毫秒） |

---

## 换模型

只改 cc switch 里的 `model` 即可，支持：

- `deepseek-v4-pro`
- `deepseek-chat`
- `deepseek-reasoner`

`base_url` 和 `api_key` 始终保持不变。

---

## 换 API Key

- **方式一**：打开 `http://127.0.0.1:8787/`，在页面保存新 Key（即时生效）
- **方式二**：直接修改 `api-key.txt` 后重启脚本

---

## 另一台电脑使用

复制整个文件夹过去，双击 `启动中转脚本.cmd` 即可。文件夹内含 `runtime\node.exe`，无需单独安装 Node.js。

---

## 已覆盖的能力

- `GET /v1/models`
- `POST /v1/responses`（JSON + SSE 流式）
- `GET /v1/responses/:id`（响应检索）
- `DELETE /v1/responses/:id`
- `instructions` 系统指令
- 字符串 / 数组格式 `input`
- `tools` 函数工具定义转换
- `tool_choice`（含 required 兼容处理）
- `function_call` 输出和回传续接
- `previous_response_id` 进程内上下文续接
- DeepSeek thinking 模式 `reasoning_content` 内部回传
- 本地 `api_key` 鉴权
- 上游超时控制
- Mock 模式完整自测

---

## 测试

```bash
# Mock 模式自测（无需 DeepSeek Key）
npm test

# 仅跑冒烟测试（需先启动服务）
npm run smoke

# 真实 API 链路验证（PowerShell）
.\verify-real.ps1 -ApiKey "sk-..."
```

---

## ⚠ 安全提醒

**`api-key.txt` 是明文保存的 API Key，已加入 `.gitignore`，不要发给别人，不要上传到网盘或代码仓库。**

---

