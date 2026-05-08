import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';


const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';

const LOCAL_API_KEY = process.env.LOCAL_API_KEY || 'local-proxy-key';
const MOCK_MODE = /^(1|true|yes)$/i.test(process.env.MOCK_MODE || '');
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 200);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);

const store = new Map();
const toolCallMessageStore = new Map();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const API_KEY_FILE = join(SCRIPT_DIR, '..', 'api-key.txt');
let currentDeepSeekApiKey = loadInitialApiKey();

function loadInitialApiKey() {
  const envKey = process.env.DEEPSEEK_API_KEY || '';
  if (envKey.trim()) return envKey.trim();
  if (!existsSync(API_KEY_FILE)) return '';
  return readFileSync(API_KEY_FILE, 'utf8').trim();
}

function getDeepSeekApiKey() {
  return currentDeepSeekApiKey.trim();
}

function saveDeepSeekApiKey(apiKey) {
  const normalized = String(apiKey || '').trim();
  currentDeepSeekApiKey = normalized;
  writeFileSync(API_KEY_FILE, normalized, 'utf8');
}

function maskApiKey(apiKey) {
  if (!apiKey) return '';
  if (apiKey.length <= 12) return `${apiKey.slice(0, 3)}****`;
  return `${apiKey.slice(0, 8)}****${apiKey.slice(-6)}`;
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function makeError(message, type = 'invalid_request_error', extra = {}) {
  return { error: { message, type, ...extra } };
}

function sendError(res, statusCode, message, type = 'invalid_request_error', extra = {}) {
  sendJson(res, statusCode, makeError(message, type, extra));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    const err = new Error(`请求体不是合法 JSON：${error.message}`);
    err.statusCode = 400;
    throw err;
  }
}

function requireLocalAuth(req, res) {
  if (!LOCAL_API_KEY) return true;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token === LOCAL_API_KEY) return true;
  sendError(res, 401, '本地桥接服务鉴权失败，请检查客户端 api_key 是否等于 LOCAL_API_KEY。', 'authentication_error');
  return false;
}

function normalizeRole(role) {
  if (role === 'developer') return 'system';
  if (role === 'system') return 'system';
  if (role === 'assistant') return 'assistant';
  if (role === 'tool') return 'tool';
  return 'user';
}

function stringifyUnknown(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function rememberAssistantMessageToolCalls(message) {
  if (!Array.isArray(message?.tool_calls)) return;
  for (const toolCall of message.tool_calls) {
    if (toolCall?.id) toolCallMessageStore.set(toolCall.id, clonePlain(message));
  }
  while (toolCallMessageStore.size > MAX_HISTORY * 8) {
    const firstKey = toolCallMessageStore.keys().next().value;
    toolCallMessageStore.delete(firstKey);
  }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return stringifyUnknown(content);

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.output_text === 'string') return part.output_text;
      if (typeof part.input_text === 'string') return part.input_text;
      if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
      if (part.type === 'input_image' || part.image_url) return '[用户提供了图片，DeepSeek chat/completions 文本桥接暂不转发图片二进制内容。]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function convertFunctionCallInput(item) {
  const callId = item.call_id || item.id || newId('call');
  const remembered = toolCallMessageStore.get(callId);
  if (remembered) return clonePlain(remembered);

  const message = {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: callId,
        type: 'function',
        function: {
          name: item.name || item.function?.name || 'unknown_function',
          arguments: typeof item.arguments === 'string' ? item.arguments : stringifyUnknown(item.arguments || item.function?.arguments || {}),
        },
      },
    ],
  };

  if (typeof item.reasoning_content === 'string') message.reasoning_content = item.reasoning_content;
  return message;
}


function convertFunctionCallOutputInput(item) {
  return {
    role: 'tool',
    tool_call_id: item.call_id || item.tool_call_id || item.id || '',
    content: typeof item.output === 'string' ? item.output : stringifyUnknown(item.output ?? item.content ?? ''),
  };
}

function toolCallIds(message) {
  if (!Array.isArray(message?.tool_calls)) return [];
  return message.tool_calls.map((toolCall) => toolCall?.id).filter(Boolean);
}

function isAssistantToolMessage(message) {
  return message?.role === 'assistant' && toolCallIds(message).length > 0;
}

function hasToolCallId(message, callId) {
  return toolCallIds(message).includes(callId);
}

function sameToolCallIds(a, b) {
  const left = toolCallIds(a).sort();
  const right = toolCallIds(b).sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function appendToolOutputWithContext(messages, toolMessage) {
  const callId = toolMessage.tool_call_id;
  const remembered = callId ? toolCallMessageStore.get(callId) : null;
  if (remembered && !messages.some((message) => hasToolCallId(message, callId))) {
    messages.push(clonePlain(remembered));
  }
  messages.push(toolMessage);
}

function makeSyntheticToolMessage(callId) {
  return {
    role: 'tool',
    tool_call_id: callId,
    content: '[工具结果缺失：桥接服务已补齐占位结果，避免上游因 tool_calls 后缺少 tool 响应而中断。]',
  };
}

function sanitizeMessagesForChatCompletions(messages) {
  const sanitized = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = clonePlain(messages[i]);

    if (message.role === 'tool') continue;

    if (!isAssistantToolMessage(message)) {
      sanitized.push(message);
      continue;
    }

    const expectedIds = toolCallIds(message);
    const toolMessages = [];
    const receivedIds = new Set();
    let nextIndex = i + 1;

    while (nextIndex < messages.length && messages[nextIndex]?.role === 'tool') {
      const toolMessage = clonePlain(messages[nextIndex]);
      if (expectedIds.includes(toolMessage.tool_call_id) && !receivedIds.has(toolMessage.tool_call_id)) {
        toolMessages.push(toolMessage);
        receivedIds.add(toolMessage.tool_call_id);
      }
      nextIndex += 1;
    }

    const nextMessage = messages[nextIndex];
    if (!toolMessages.length && isAssistantToolMessage(nextMessage) && sameToolCallIds(message, nextMessage)) {
      continue;
    }

    if (!toolMessages.length && nextMessage && nextMessage.role !== 'tool') {
      continue;
    }

    sanitized.push(message);
    sanitized.push(...toolMessages);
    for (const callId of expectedIds) {
      if (!receivedIds.has(callId)) sanitized.push(makeSyntheticToolMessage(callId));
    }
    i = nextIndex - 1;
  }

  return sanitized;
}

function buildMessagesFromInput(body) {
  const messages = [];

  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions.trim() });
  }

  const input = body.input ?? body.messages;
  if (typeof input === 'string') {
    if (input.trim()) messages.push({ role: 'user', content: input });
    return messages;
  }

  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'function_call') {
      messages.push(convertFunctionCallInput(item));
      continue;
    }

    if (item.type === 'function_call_output') {
      appendToolOutputWithContext(messages, convertFunctionCallOutputInput(item));
      continue;
    }

    if (item.type === 'input_text' && typeof item.text === 'string') {
      messages.push({ role: 'user', content: item.text });
      continue;
    }

    if (item.type === 'message' || item.role) {
      const role = normalizeRole(item.role || 'user');
      const content = extractText(item.content ?? item.input ?? item.text);
      const message = { role, content };

      if (role === 'tool') {
        message.tool_call_id = item.tool_call_id || item.call_id || item.id || '';
        appendToolOutputWithContext(messages, message);
        continue;
      }

      if (role === 'assistant' && Array.isArray(item.tool_calls)) {
        message.tool_calls = item.tool_calls;
      }

      if (role === 'assistant' && typeof item.reasoning_content === 'string') {
        message.reasoning_content = item.reasoning_content;
      }

      messages.push(message);
    }
  }

  return messages;
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;

  const converted = tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return null;
      if (tool.type !== 'function') return null;

      if (tool.function?.name) {
        return {
          type: 'function',
          function: {
            name: tool.function.name,
            description: tool.function.description || '',
            parameters: tool.function.parameters || { type: 'object', properties: {} },
            ...(typeof tool.function.strict === 'boolean' ? { strict: tool.function.strict } : {}),
          },
        };
      }

      if (!tool.name) return null;
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} },
          ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
        },
      };
    })
    .filter(Boolean);

  return converted.length ? converted : undefined;
}

function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    const name = toolChoice.name || toolChoice.function?.name;
    if (name) return { type: 'function', function: { name } };
  }
  return undefined;
}

function trimStore() {
  while (store.size > MAX_HISTORY) {
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
  }
}

function buildChatPayload(body, stream = false) {
  const previous = body.previous_response_id ? store.get(body.previous_response_id) : null;
  const incomingMessages = buildMessagesFromInput(body);
  const rawMessages = [...(previous?.messages || []), ...incomingMessages];
  const messages = sanitizeMessagesForChatCompletions(rawMessages);

  if (!messages.length) {
    const err = new Error('没有可转发的消息内容，请至少提供 input。');
    err.statusCode = 400;
    throw err;
  }

  const payloadMessages = [...messages];
  const payload = {
    model: body.model || DEEPSEEK_MODEL,
    messages: payloadMessages,
    stream,
  };

  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  if (typeof body.top_p === 'number') payload.top_p = body.top_p;
  if (typeof body.max_output_tokens === 'number') payload.max_tokens = body.max_output_tokens;
  if (typeof body.max_tokens === 'number') payload.max_tokens = body.max_tokens;

  const tools = convertTools(body.tools);
  const toolChoice = convertToolChoice(body.tool_choice);
  if (tools && toolChoice !== 'none') payload.tools = tools;

  if (tools && toolChoice === 'required') {
    payloadMessages.unshift({ role: 'system', content: '当前请求要求必须调用一个可用工具。请根据用户目标选择最合适的工具并返回 tool_call，不要只用文字回答。' });
  } else if (tools && typeof toolChoice === 'object') {
    payloadMessages.unshift({ role: 'system', content: `当前请求要求调用工具 ${toolChoice.function.name}。请返回该工具的 tool_call，不要只用文字回答。` });
  }


  return {
    payload,
    previousMessages: previous?.messages || [],
    incomingMessages,
  };
}

function pickToolForMock(chatRequest) {
  const tools = Array.isArray(chatRequest.tools) ? chatRequest.tools : [];
  if (!tools.length) return null;
  if (chatRequest.tool_choice === 'required') return tools[0];
  if (typeof chatRequest.tool_choice === 'object') {
    const name = chatRequest.tool_choice.function?.name;
    return tools.find((tool) => tool.function?.name === name) || tools[0];
  }
  const last = chatRequest.messages.at(-1)?.content || '';
  if (/工具|tool|function|调用/i.test(last)) return tools[0];
  return null;
}

function validateToolMessageOrder(messages) {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!isAssistantToolMessage(message)) continue;

    const expectedIds = toolCallIds(message);
    const receivedIds = new Set();
    let nextIndex = i + 1;
    while (nextIndex < messages.length && messages[nextIndex]?.role === 'tool') {
      if (messages[nextIndex].tool_call_id) receivedIds.add(messages[nextIndex].tool_call_id);
      nextIndex += 1;
    }

    if (!expectedIds.every((callId) => receivedIds.has(callId))) {
      const err = new Error("An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)");
      err.statusCode = 400;
      err.payload = { error: { message: err.message, type: 'invalid_request_error', code: 'invalid_request_error' } };
      throw err;
    }
  }
}

function buildMockChatCompletion(chatRequest) {
  validateToolMessageOrder(chatRequest.messages);
  const hasToolResult = chatRequest.messages.some((message) => message.role === 'tool');
  const assistantToolMessage = chatRequest.messages.find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length);
  if (hasToolResult && assistantToolMessage && !assistantToolMessage.reasoning_content) {
    const err = new Error('The `reasoning_content` in the thinking mode must be passed back to the API.');
    err.statusCode = 400;
    err.payload = { error: { message: err.message, type: 'invalid_request_error', code: 'invalid_request_error' } };
    throw err;
  }

  const tool = pickToolForMock(chatRequest);
  if (tool) {
    const callId = newId('call');
    return {
      id: newId('chatcmpl'),
      object: 'chat.completion',
      created: nowTs(),
      model: chatRequest.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'mock reasoning for tool call',
            tool_calls: [
              {
                id: callId,
                type: 'function',
                function: {
                  name: tool.function.name,
                  arguments: JSON.stringify({ query: 'mock' }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 },
    };
  }

  const lastMessage = chatRequest.messages.at(-1)?.content || '（空）';
  const responseText = `这是本地 mock 响应。最后一条用户消息：${lastMessage}`;
  return {
    id: newId('chatcmpl'),
    object: 'chat.completion',
    created: nowTs(),
    model: chatRequest.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: responseText },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 16, completion_tokens: 16, total_tokens: 32 },
  };
}

async function fetchDeepSeek(chatRequest) {
  if (MOCK_MODE && !chatRequest.stream) return buildMockChatCompletion(chatRequest);

  const apiKey = getDeepSeekApiKey();
  if (!MOCK_MODE && !apiKey) {
    const err = new Error('未设置 DeepSeek API Key，请打开可视化页面保存 API Key。');
    err.statusCode = 500;
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(!MOCK_MODE ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(chatRequest),
    });

    if (chatRequest.stream) return response;

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const message = data?.error?.message || data?.message || text || `DeepSeek 返回 ${response.status}`;
      const err = new Error(message);
      err.statusCode = response.status;
      err.payload = data;
      throw err;
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const err = new Error(`请求 DeepSeek 超时：${REQUEST_TIMEOUT_MS}ms`);
      err.statusCode = 504;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function* mockChatStream(chatRequest) {
  const completion = buildMockChatCompletion({ ...chatRequest, stream: false });
  const message = completion.choices[0].message;
  const base = {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
  };

  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    const toolCall = message.tool_calls[0];
    yield {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            reasoning_content: message.reasoning_content || '',
            tool_calls: [
              {
                index: 0,
                id: toolCall.id,
                type: 'function',
                function: { name: toolCall.function.name, arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    yield {
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: toolCall.function.arguments } }] },
          finish_reason: null,
        },
      ],
    };
    yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
    return;
  }

  const text = message.content || '';
  const chunks = text.match(/.{1,12}/gs) || [''];
  yield { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
  for (const chunk of chunks) {
    yield { ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] };
  }
  yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
}

async function* parseSseJsonStream(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');

      if (!data) continue;
      if (data === '[DONE]') return;
      yield JSON.parse(data);
    }
  }

  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim();
    if (data && data !== '[DONE]') yield JSON.parse(data);
  }
}

async function* getChatStream(chatRequest) {
  if (MOCK_MODE) {
    yield* mockChatStream(chatRequest);
    return;
  }

  const response = await fetchDeepSeek(chatRequest);
  if (!response.ok) {
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    const err = new Error(data?.error?.message || data?.message || text || `DeepSeek 返回 ${response.status}`);
    err.statusCode = response.status;
    err.payload = data;
    throw err;
  }

  yield* parseSseJsonStream(response.body);
}

function responseOutputFromChat(chatData) {
  const message = chatData?.choices?.[0]?.message || {};
  const assistantText = typeof message.content === 'string' ? message.content : '';
  const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const output = [];

  if (assistantText || !toolCalls.length) {
    output.push({
      id: newId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: assistantText, annotations: [] }],
    });
  }

  for (const toolCall of toolCalls) {
    const callId = toolCall.id || newId('call');
    output.push({
      id: callId,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name: toolCall.function?.name || 'unknown_function',
      arguments: toolCall.function?.arguments || '{}',
    });
  }

  return { assistantText, output, toolCalls, reasoningContent };
}

function buildUsage(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    output_tokens_details: { reasoning_tokens: usage.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens || 0 },
  };
}

function buildResponseObject(body, chatData, responseId, outputOverride) {
  const converted = outputOverride || responseOutputFromChat(chatData);
  return {
    id: responseId,
    object: 'response',
    created_at: nowTs(),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: body.instructions || null,
    max_output_tokens: body.max_output_tokens || body.max_tokens || null,
    model: chatData?.model || body.model || DEEPSEEK_MODEL,
    output: converted.output,
    output_text: converted.assistantText || '',
    parallel_tool_calls: true,
    previous_response_id: body.previous_response_id || null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: typeof body.temperature === 'number' ? body.temperature : null,
    text: { format: { type: 'text' } },
    tool_choice: body.tool_choice || 'auto',
    tools: body.tools || [],
    top_p: typeof body.top_p === 'number' ? body.top_p : null,
    truncation: 'disabled',
    usage: buildUsage(chatData?.usage),
    user: body.user || null,
    metadata: body.metadata || {},
  };
}

function outputToAssistantMessage(output, reasoningContent = '') {
  const textItem = output.find((item) => item.type === 'message');
  const toolItems = output.filter((item) => item.type === 'function_call');
  const content = textItem?.content?.map((part) => part.text || '').join('') || '';
  const message = { role: 'assistant', content };

  if (reasoningContent) message.reasoning_content = reasoningContent;

  if (toolItems.length) {
    message.tool_calls = toolItems.map((item) => ({
      id: item.call_id || item.id,
      type: 'function',
      function: { name: item.name, arguments: item.arguments || '{}' },
    }));
  }

  return message;
}

function storeResponse(responseId, responseObject, priorMessages, incomingMessages, assistantMessageOverride) {
  const assistantMessage = assistantMessageOverride ? clonePlain(assistantMessageOverride) : outputToAssistantMessage(responseObject.output);
  rememberAssistantMessageToolCalls(assistantMessage);
  store.set(responseId, {
    response: responseObject,
    messages: [...priorMessages, ...incomingMessages, assistantMessage],
    createdAt: Date.now(),
  });
  trimStore();
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startResponsesSse(res, responseId, model) {
  setCors(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  writeSse(res, 'response.created', {
    type: 'response.created',
    response: {
      id: responseId,
      object: 'response',
      created_at: nowTs(),
      status: 'in_progress',
      model,
      output: [],
    },
  });
}

function emitSseError(res, responseId, error) {
  writeSse(res, 'response.failed', {
    type: 'response.failed',
    response: {
      id: responseId,
      object: 'response',
      created_at: nowTs(),
      status: 'failed',
      error: { message: error.message || '流式请求失败', type: error.statusCode ? 'upstream_error' : 'server_error' },
    },
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleResponsesJson(res, body) {
  const responseId = newId('resp');
  const { payload, previousMessages, incomingMessages } = buildChatPayload(body, false);
  const chatData = await fetchDeepSeek(payload);
  const converted = responseOutputFromChat(chatData);
  const responseObject = buildResponseObject(body, chatData, responseId, converted);
  const assistantMessage = outputToAssistantMessage(converted.output, converted.reasoningContent);
  storeResponse(responseId, responseObject, previousMessages, incomingMessages, assistantMessage);
  sendJson(res, 200, responseObject);
}

async function handleResponsesStream(res, body) {
  const responseId = newId('resp');
  const { payload, previousMessages, incomingMessages } = buildChatPayload(body, true);
  const output = [];
  const toolStates = new Map();
  let textItem = null;
  let assistantText = '';
  let reasoningContent = '';
  let chatModel = payload.model;
  let usage = {};

  startResponsesSse(res, responseId, payload.model);

  function ensureTextItem() {
    if (textItem) return textItem;
    textItem = {
      id: newId('msg'),
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    };
    output.push(textItem);
    writeSse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: output.length - 1,
      item: textItem,
    });
    writeSse(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: textItem.id,
      output_index: output.length - 1,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    return textItem;
  }

  function ensureToolState(deltaTool) {
    const index = Number(deltaTool.index ?? 0);
    let state = toolStates.get(index);
    if (state) {
      if (deltaTool.function?.name) {
        state.name += deltaTool.function.name;
        const item = output[state.outputIndex];
        if (item) item.name = state.name;
      }
      return state;
    }

    const callId = deltaTool.id || newId('call');
    state = {
      index,
      id: callId,
      call_id: callId,
      name: deltaTool.function?.name || '',
      arguments: '',
      outputIndex: output.length,
    };
    toolStates.set(index, state);

    const item = {
      id: state.id,
      type: 'function_call',
      status: 'in_progress',
      call_id: state.call_id,
      name: state.name,
      arguments: '',
    };
    output.push(item);
    writeSse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: state.outputIndex,
      item,
    });
    return state;
  }

  try {
    for await (const chunk of getChatStream(payload)) {
      chatModel = chunk.model || chatModel;
      usage = chunk.usage || usage;
      const choice = chunk.choices?.[0] || {};
      const delta = choice.delta || {};

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
        reasoningContent += delta.reasoning_content;
      }

      if (typeof delta.content === 'string' && delta.content.length) {
        const item = ensureTextItem();
        assistantText += delta.content;
        writeSse(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: output.indexOf(item),
          content_index: 0,
          delta: delta.content,
        });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const deltaTool of delta.tool_calls) {
          const state = ensureToolState(deltaTool);
          const item = output[state.outputIndex];
          if (deltaTool.id) {
            state.id = deltaTool.id;
            state.call_id = deltaTool.id;
            item.id = deltaTool.id;
            item.call_id = deltaTool.id;
          }
          item.name = state.name;
          if (deltaTool.function?.arguments) {
            state.arguments += deltaTool.function.arguments;
            writeSse(res, 'response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              item_id: state.id,
              output_index: state.outputIndex,
              delta: deltaTool.function.arguments,
            });
          }
        }
      }
    }

    if (textItem) {
      textItem.status = 'completed';
      textItem.content = [{ type: 'output_text', text: assistantText, annotations: [] }];
      const outputIndex = output.indexOf(textItem);
      writeSse(res, 'response.output_text.done', {
        type: 'response.output_text.done',
        item_id: textItem.id,
        output_index: outputIndex,
        content_index: 0,
        text: assistantText,
      });
      writeSse(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        item_id: textItem.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: assistantText, annotations: [] },
      });
      writeSse(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: textItem,
      });
    }

    for (const state of [...toolStates.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      const item = output[state.outputIndex];
      item.status = 'completed';
      item.id = state.id;
      item.call_id = state.call_id;
      item.name = state.name || 'unknown_function';
      item.arguments = state.arguments || '{}';
      writeSse(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: state.outputIndex,
        arguments: item.arguments,
      });
      writeSse(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.outputIndex,
        item,
      });
    }

    if (!output.length) {
      const emptyItem = {
        id: newId('msg'),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      };
      output.push(emptyItem);
      writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: emptyItem });
      writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: emptyItem });
    }

    const responseObject = buildResponseObject(
      body,
      { model: chatModel, usage },
      responseId,
      { assistantText, output, toolCalls: [], reasoningContent },
    );
    const assistantMessage = outputToAssistantMessage(output, reasoningContent);
    storeResponse(responseId, responseObject, previousMessages, incomingMessages, assistantMessage);

    writeSse(res, 'response.completed', { type: 'response.completed', response: responseObject });
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    log('stream failed:', error);
    emitSseError(res, responseId, error);
  }
}

async function handleResponses(req, res) {
  const body = await readJsonBody(req);
  if (body.stream) {
    await handleResponsesStream(res, body);
    return;
  }
  await handleResponsesJson(res, body);
}

function responseIdFromPath(pathname) {
  const match = pathname.match(/^\/v1\/responses\/([^/]+)$/);
  return match?.[1] || null;
}

function sendHtml(res, html) {
  setCors(res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function renderAdminPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DeepSeek 中转脚本控制台</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: "Microsoft YaHei", Arial, sans-serif; background: linear-gradient(135deg, #07111f, #102a4c 55%, #0f172a); color: #e5eefc; }
    .wrap { max-width: 980px; margin: 0 auto; padding: 36px 18px; }
    .hero { border: 1px solid rgba(125, 211, 252, .25); background: rgba(15, 23, 42, .78); border-radius: 24px; padding: 30px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
    .badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; color: #082f49; background: #7dd3fc; font-weight: 800; }
    h1 { margin: 18px 0 8px; font-size: clamp(28px, 5vw, 48px); letter-spacing: -1px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 18px; }
    .card { border: 1px solid rgba(148, 163, 184, .22); background: rgba(2, 6, 23, .55); border-radius: 20px; padding: 22px; }
    label { display: block; margin: 14px 0 8px; color: #bfdbfe; font-weight: 700; }
    input { width: 100%; padding: 14px 16px; border-radius: 14px; border: 1px solid #334155; outline: none; background: #020617; color: #e5eefc; font-size: 15px; }
    input:focus { border-color: #38bdf8; box-shadow: 0 0 0 4px rgba(56, 189, 248, .16); }
    button { border: 0; border-radius: 14px; padding: 13px 18px; color: #082f49; background: #7dd3fc; font-weight: 900; cursor: pointer; margin-top: 14px; margin-right: 10px; }
    button.secondary { background: #c4b5fd; color: #1e1b4b; }
    button:hover { filter: brightness(1.08); }
    .status { min-height: 24px; margin-top: 12px; font-weight: 700; }
    .muted { color: #94a3b8; line-height: 1.65; }
    code { color: #fde68a; }
    .ok { color: #86efac; }
    .bad { color: #fca5a5; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } .hero { padding: 22px; } }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div class="badge">DeepSeek / Codex 中转控制台</div>
      <h1>可视化配置 API Key</h1>
      <p class="muted">这里保存的是 DeepSeek 官方 API Key。Codex / cc switch 里仍然填写本地口令 <code>local-proxy-key</code>。</p>
      <div class="grid">
        <div class="card">
          <h2>API Key 设置</h2>
          <p class="muted">当前状态：<span id="keyState">读取中...</span></p>
          <label for="apiKey">DeepSeek API Key</label>
          <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off" />
          <button id="saveBtn">保存 API Key</button>
          <button id="showBtn" class="secondary">显示/隐藏</button>
          <div id="saveStatus" class="status"></div>
        </div>
        <div class="card">
          <h2>连接信息</h2>
          <p class="muted">cc switch / Codex 配置：</p>
          <p><code>base_url = http://127.0.0.1:8787/v1</code></p>
          <p><code>model = deepseek-v4-pro</code> 或你想使用的 DeepSeek 模型名</p>
          <p><code>api_key = local-proxy-key</code></p>
          <button id="testBtn">测试真实 DeepSeek 连接</button>
          <div id="testStatus" class="status"></div>
        </div>
      </div>
    </section>
  </main>
<script>
const apiKeyInput = document.getElementById('apiKey');
const keyState = document.getElementById('keyState');
const saveStatus = document.getElementById('saveStatus');
const testStatus = document.getElementById('testStatus');

async function loadConfig() {
  const res = await fetch('/admin/config');
  const cfg = await res.json();
  keyState.innerHTML = cfg.apiKeySet ? '<span class="ok">已保存：' + cfg.maskedApiKey + '</span>' : '<span class="bad">未保存</span>';
}

document.getElementById('showBtn').onclick = () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
};

document.getElementById('saveBtn').onclick = async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    saveStatus.innerHTML = '<span class="bad">请先输入 API Key。</span>';
    return;
  }
  saveStatus.textContent = '正在保存...';
  const res = await fetch('/admin/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey })
  });
  const data = await res.json();
  if (!res.ok) {
    saveStatus.innerHTML = '<span class="bad">保存失败：' + (data.error?.message || res.status) + '</span>';
    return;
  }
  apiKeyInput.value = '';
  saveStatus.innerHTML = '<span class="ok">已保存，当前服务立即生效。</span>';
  await loadConfig();
};

document.getElementById('testBtn').onclick = async () => {
  testStatus.textContent = '正在测试真实 DeepSeek 连接...';
  const res = await fetch('/admin/test', { method: 'POST' });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    testStatus.innerHTML = '<span class="bad">测试失败：' + (data.error?.message || data.message || res.status) + '</span>';
    return;
  }
  testStatus.innerHTML = '<span class="ok">测试通过：' + data.output_text + '</span>';
};

loadConfig().catch((err) => {
  keyState.innerHTML = '<span class="bad">读取失败：' + err.message + '</span>';
});
</script>
</body>
</html>`;
}

async function handleAdminConfig(req, res) {
  if (req.method === 'GET') {
    const apiKey = getDeepSeekApiKey();
    sendJson(res, 200, {
      ok: true,
      apiKeySet: Boolean(apiKey),
      maskedApiKey: maskApiKey(apiKey),
      model: DEEPSEEK_MODEL,
      base_url: `http://${HOST}:${PORT}/v1`,
      local_api_key: LOCAL_API_KEY,
    });
    return;
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) {
      sendError(res, 400, 'API Key 不能为空。');
      return;
    }
    saveDeepSeekApiKey(apiKey);
    sendJson(res, 200, { ok: true, apiKeySet: true, maskedApiKey: maskApiKey(apiKey) });
    return;
  }

  sendError(res, 405, 'Method not allowed');
}

async function handleAdminTest(res) {
  const chatData = await fetchDeepSeek({
    model: DEEPSEEK_MODEL,
    messages: [{ role: 'user', content: 'Please reply only: ok' }],
    stream: false,
  });
  const outputText = chatData?.choices?.[0]?.message?.content || '';
  sendJson(res, 200, { ok: true, output_text: outputText, model: chatData?.model || DEEPSEEK_MODEL });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if ((url.pathname === '/' || url.pathname === '/admin') && req.method === 'GET') {
      sendHtml(res, renderAdminPage());
      return;
    }

    if (url.pathname === '/admin/config') {
      await handleAdminConfig(req, res);
      return;
    }

    if (url.pathname === '/admin/test' && req.method === 'POST') {
      await handleAdminTest(res);
      return;
    }

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        mock_mode: MOCK_MODE,
        host: HOST,
        port: PORT,
        model: DEEPSEEK_MODEL,
        api_key_set: Boolean(getDeepSeekApiKey()),
        masked_api_key: maskApiKey(getDeepSeekApiKey()),
        local_auth_enabled: Boolean(LOCAL_API_KEY),
        upstream: `${DEEPSEEK_BASE_URL}/chat/completions`,
      });
      return;
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      if (!requireLocalAuth(req, res)) return;
      sendJson(res, 200, {
        object: 'list',
        data: [{ id: DEEPSEEK_MODEL, object: 'model', created: nowTs(), owned_by: 'deepseek' }],
      });
      return;
    }

    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      if (!requireLocalAuth(req, res)) return;
      await handleResponses(req, res);
      return;
    }

    const responseId = responseIdFromPath(url.pathname);
    if (responseId && req.method === 'GET') {
      if (!requireLocalAuth(req, res)) return;
      const record = store.get(responseId);
      if (!record) {
        sendError(res, 404, `未找到 response：${responseId}`, 'not_found_error');
        return;
      }
      sendJson(res, 200, record.response);
      return;
    }

    if (responseId && req.method === 'DELETE') {
      if (!requireLocalAuth(req, res)) return;
      const deleted = store.delete(responseId);
      sendJson(res, 200, { id: responseId, object: 'response.deleted', deleted });
      return;
    }

    sendError(res, 404, `未找到路由：${req.method} ${url.pathname}`, 'not_found_error');
  } catch (error) {
    log('request failed:', error);
    sendError(
      res,
      error.statusCode || 500,
      error.message || '服务器内部错误',
      error.statusCode && error.statusCode < 500 ? 'upstream_error' : 'server_error',
      error.payload ? { upstream: error.payload } : {},
    );
  }
});

server.listen(PORT, HOST, () => {
  log(`bridge listening on http://${HOST}:${PORT}`);
  log(`mock mode: ${MOCK_MODE ? 'enabled' : 'disabled'}`);
  log(`deepseek upstream: ${DEEPSEEK_BASE_URL}/chat/completions`);
  log(`deepseek model: ${DEEPSEEK_MODEL}`);
});
