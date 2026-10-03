#!/usr/bin/env node
/** Verify bounded log rotation retains recent history instead of replacing it with one line. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\');
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
  await sleep(250);
  const content = readFileSync(logFile, 'utf8');
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
