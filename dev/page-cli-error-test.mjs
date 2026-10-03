#!/usr/bin/env node
/** CLI regression: text/html selector failures must both be visible and non-zero. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../page.mjs', import.meta.url));
const TOKEN = 'page-cli-error-test-token';
const server = createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/cmd') {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { ok: false, reason: '找不到元素：#missing' } }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const run = (command, port) => new Promise((resolve) => {
  const child = spawn(process.execPath, [PAGE, command, '--selector', '#missing', '--no-autostart', '--port', String(port), '--token', TOKEN], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const port = server.address().port;
  for (const command of ['text', 'html']) {
    const result = await run(command, port);
    check(`${command} selector 失败返回非零退出码`, result.status !== 0, JSON.stringify(result));
    check(`${command} selector 失败不打印空内容`, result.stdout === '', JSON.stringify(result));
    check(`${command} selector 失败输出原因`, result.stderr.includes('找不到元素：#missing'), JSON.stringify(result));
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\n${failures ? `✗ ${failures} 个失败` : '✓ page CLI 错误处理测试通过'}`);
process.exitCode = failures ? 1 : 0;
