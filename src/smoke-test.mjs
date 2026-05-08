const baseUrl = process.env.BRIDGE_BASE_URL || 'http://127.0.0.1:8787';
const apiKey = process.env.LOCAL_API_KEY || 'local-proxy-key';

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  };
}

async function assertOk(response, label) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} 失败: ${response.status} ${text}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseSse(text) {
  return text
    .split(/\n\n+/)
    .map((block) => {
      const event = block
        .split(/\n/)
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      const data = block
        .split(/\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      return { event, data };
    })
    .filter((item) => item.event || item.data);
}

async function testHealth() {
  const response = await fetch(`${baseUrl}/health`);
  await assertOk(response, 'health');
  const json = await response.json();
  assert(json.ok === true, 'health 接口未返回 ok=true');
  assert(json.upstream.endsWith('/chat/completions'), '上游地址没有指向 chat/completions');
  console.log('✓ /health 正常');
}

async function testAuthFailure() {
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: 'Bearer wrong-key' },
  });
  assert(response.status === 401, '错误 api_key 没有返回 401');
  console.log('✓ 本地鉴权正常');
}

async function testModels() {
  const response = await fetch(`${baseUrl}/v1/models`, { headers: headers() });
  await assertOk(response, 'models');
  const json = await response.json();
  assert(Array.isArray(json.data) && json.data.length > 0, '/v1/models 未返回模型列表');
  assert(json.data[0].id === 'deepseek-v4-pro', '/v1/models 返回模型不是 deepseek-v4-pro');
  console.log('✓ /v1/models 正常');
}

async function createResponse(body) {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  await assertOk(response, 'responses json');
  return response.json();
}

async function testResponsesJson() {
  const json = await createResponse({
    model: 'deepseek-v4-pro',
    instructions: '你是一个测试助手。',
    input: '你好，请只回复 ok',
    stream: false,
  });
  assert(json.object === 'response', '/v1/responses 未返回 response 对象');
  assert(json.status === 'completed', 'response 状态不是 completed');
  assert(typeof json.output_text === 'string', 'response 缺少 output_text');
  assert(Array.isArray(json.output) && json.output.length > 0, 'response 缺少 output');
  console.log('✓ /v1/responses JSON 正常');
  return json;
}

async function testResponseRetrieve(previous) {
  const response = await fetch(`${baseUrl}/v1/responses/${previous.id}`, { headers: headers() });
  await assertOk(response, 'responses retrieve');
  const json = await response.json();
  assert(json.id === previous.id, 'GET /v1/responses/:id 返回 id 不一致');
  console.log('✓ /v1/responses/:id 读取正常');
}

async function testPreviousResponseId(previous) {
  const json = await createResponse({
    model: 'deepseek-v4-pro',
    previous_response_id: previous.id,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续上一轮。' }] }],
  });
  assert(json.previous_response_id === previous.id, 'previous_response_id 没有原样返回');
  assert(json.status === 'completed', '续接响应未完成');
  console.log('✓ previous_response_id 续接正常');
}

async function testToolCallJson() {
  const json = await createResponse({
    model: 'deepseek-v4-pro',
    input: '请调用工具查询 mock',
    tools: [
      {
        type: 'function',
        name: 'search_docs',
        description: '搜索文档',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
    tool_choice: 'required',
  });
  const toolCall = json.output.find((item) => item.type === 'function_call');
  assert(toolCall, '工具调用响应缺少 function_call');
  assert(toolCall.name === 'search_docs', '工具调用函数名不正确');
  assert(toolCall.call_id && toolCall.id === toolCall.call_id, '工具调用 id/call_id 不一致');
  console.log('✓ 工具调用 JSON 转换正常');
  return { response: json, toolCall };
}

async function testToolCallContinuation(previous) {
  const json = await createResponse({
    model: 'deepseek-v4-pro',
    previous_response_id: previous.response.id,
    input: [
      {
        type: 'function_call_output',
        call_id: previous.toolCall.call_id,
        output: '{"result":"mock ok"}',
      },
    ],
  });
  assert(json.status === 'completed', '工具调用结果回传后响应未完成');
  assert(typeof json.output_text === 'string', '工具调用结果回传后缺少 output_text');
  console.log('✓ 工具调用结果回传续接正常');
}

async function testToolCallContinuationWithoutPrevious(previous) {
  const json = await createResponse({
    model: 'deepseek-v4-pro',
    input: [
      {
        type: 'function_call_output',
        call_id: previous.toolCall.call_id,
        output: '{"result":"mock ok without previous"}',
      },
    ],
  });
  assert(json.status === 'completed', '无 previous_response_id 的工具回传未完成');
  console.log('✓ 无 previous_response_id 工具回传续接正常');
}

async function testDanglingToolCallHistory(previous) {
  const json = await createResponse({
    model: 'deepseek-v4-pro',
    previous_response_id: previous.response.id,
    input: '上一轮工具没有返回时，继续正常回复。',
  });
  assert(json.status === 'completed', '缺失工具结果的历史没有被自动修复');
  console.log('✓ 缺失工具结果历史自动修复正常');
}


async function testResponsesStream() {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      input: '请流式返回一句话',
      stream: true,
    }),
  });
  await assertOk(response, 'responses stream');
  assert(response.headers.get('content-type')?.includes('text/event-stream'), '流式响应 Content-Type 不正确');
  const text = await response.text();
  const events = parseSse(text).map((item) => item.event || item.data);
  assert(events.includes('response.created'), '流式响应缺少 response.created');
  assert(events.includes('response.output_text.delta'), '流式响应缺少 response.output_text.delta');
  assert(events.includes('response.output_text.done'), '流式响应缺少 response.output_text.done');
  assert(events.includes('response.completed'), '流式响应缺少 response.completed');
  assert(text.includes('[DONE]'), '流式响应缺少 [DONE]');
  console.log('✓ /v1/responses Stream 文本正常');
}

async function testToolCallStream() {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      input: '请流式调用工具',
      stream: true,
      tools: [
        {
          type: 'function',
          name: 'search_docs',
          description: '搜索文档',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
      tool_choice: 'required',
    }),
  });
  await assertOk(response, 'responses stream tool');
  const text = await response.text();
  assert(text.includes('response.function_call_arguments.delta'), '流式工具调用缺少 arguments delta');
  assert(text.includes('response.function_call_arguments.done'), '流式工具调用缺少 arguments done');
  assert(text.includes('response.completed'), '流式工具调用缺少 completed');
  const completed = parseSse(text).find((item) => item.event === 'response.completed');
  assert(completed, '流式工具调用缺少 completed 事件数据');
  const payload = JSON.parse(completed.data);
  const toolCall = payload.response.output.find((item) => item.type === 'function_call');
  assert(toolCall?.name === 'search_docs', '流式工具调用函数名不正确');
  console.log('✓ 工具调用 Stream 转换正常');
  return { response: payload.response, toolCall };
}

const first = await testHealth()
  .then(testAuthFailure)
  .then(testModels)
  .then(testResponsesJson);
await testResponseRetrieve(first);
await testPreviousResponseId(first);
const jsonTool = await testToolCallJson();
await testToolCallContinuation(jsonTool);
await testToolCallContinuationWithoutPrevious(jsonTool);
await testDanglingToolCallHistory(jsonTool);
await testResponsesStream();
const streamTool = await testToolCallStream();
await testToolCallContinuation(streamTool);
console.log('\n所有桥接自测已通过。');
