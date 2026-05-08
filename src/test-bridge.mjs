import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = process.env.TEST_PORT || '8799';
const baseUrl = `http://127.0.0.1:${port}`;
const localApiKey = 'local-proxy-key';

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: port,
    MOCK_MODE: '1',
    LOCAL_API_KEY: localApiKey,
    DEEPSEEK_MODEL: 'deepseek-v4-pro',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (data) => process.stdout.write(`[bridge] ${data}`));
child.stderr.on('data', (data) => process.stderr.write(`[bridge] ${data}`));

async function waitUntilReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // wait
    }
    await delay(200);
  }
  throw new Error('桥接服务 10 秒内没有启动成功');
}

try {
  await waitUntilReady();
  const test = spawn(process.execPath, ['smoke-test.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      BRIDGE_BASE_URL: baseUrl,
      LOCAL_API_KEY: localApiKey,
    },
    stdio: 'inherit',
  });

  const exitCode = await new Promise((resolve) => test.on('exit', resolve));
  if (exitCode !== 0) process.exit(exitCode ?? 1);
} finally {
  child.kill('SIGTERM');
}
