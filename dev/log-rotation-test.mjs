#!/usr/bin/env node
/** Verify bounded log rotation retains recent history instead of replacing it with one line. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath：曾经写成 `.pathname.replace(/^\//,'').replaceAll('/','\\')`（Windows 专用），
// 在 CI 的 Linux runner 上会变成 `home\runner\...`，桥接根本起不来 —— 该测试因此在 CI 上必挂。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE = join(ROOT, 'bridge.mjs');
const workDir = mkdtempSync(join(tmpdir(), 'bridge-log-'));
const logFile = join(workDir, 'events.jsonl');
const tokenFile = join(workDir, 'token');
const port = Number(process.env.TEST_PORT ?? 8794);
const MAX_LOG_BYTES = 64 * 1024;
const child = spawn(process.execPath, [BRIDGE, '--native', '--port', String(port), '--idle-exit', '0', '--max-log-bytes', String(MAX_LOG_BYTES), '--log', logFile, '--token-file', tokenFile], {
  stdio: ['pipe', 'ignore', 'pipe'],
});
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const frame = (value) => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  for (let i = 0; i < 40 && !existsSync(logFile); i += 1) await sleep(50);
  child.stdin.write(frame({ type: 'hello', agent: 'chrome-extension', browser: 'test', version: 'test' }));
  for (let i = 1; i <= 8; i += 1) {
    child.stdin.write(frame({
      type: 'event', name: 'page-pushed', ts: Date.now(),
      tab: { id: i, url: `https://example.test/path?secret=${i}`, title: `marker-${i}` },
      state: { url: `https://example.test/path?secret=${i}`, marker: `marker-${i}`, filler: 'x'.repeat(12_000) },
    }));
  }
  // 不再等固定时长：CI 的 Linux runner 在负载下 250ms 可能不够，本测试因此在 #32 偶发失败。
  // 改为"等到最后一个事件真正落盘"，并给 5 秒上限（超时也继续，让下面的断言给出明确失败）。
  const deadline = Date.now() + 5000;
  let content = '';
  for (;;) {
    content = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    if (content.includes('marker-8') || Date.now() > deadline) break;
    await sleep(50);
  }
  const lines = content.trim().split('\n').filter(Boolean);
  check('日志大小不超过配置上限', Buffer.byteLength(content) <= MAX_LOG_BYTES, `${Buffer.byteLength(content)} bytes`);
  check('轮转后仍保留最近两条以上历史', lines.length >= 2, `lines=${lines.length}`);
  check('日志保留最新事件', content.includes('marker-8'), content.slice(-300));
  check('日志保留上一条历史', content.includes('marker-7'), content.slice(-300));
  check('落盘 URL 仍移除 query/hash', !content.includes('secret='), content.slice(-300));
} finally {
  try { child.stdin.end(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n${failures ? `✗ ${failures} 个失败` : '✓ 日志轮转测试通过'}`);
process.exit(failures ? 1 : 0);
