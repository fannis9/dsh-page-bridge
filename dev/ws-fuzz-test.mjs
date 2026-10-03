#!/usr/bin/env node
/** Systematic malformed-WebSocket checks: every bad connection closes and the bridge survives. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 同 log-rotation-test：不要用 `.pathname` + 反斜杠替换（Windows 专用），改用跨平台的 fileURLToPath。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE = join(ROOT, 'bridge.mjs');
const workDir = mkdtempSync(join(tmpdir(), 'bridge-ws-fuzz-'));
const tokenFile = join(workDir, 'token');
const logFile = join(workDir, 'events.jsonl');
const port = Number(process.env.TEST_PORT ?? 8793);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const child = spawn(process.execPath, [BRIDGE, '--port', String(port), '--idle-exit', '0', '--log', logFile, '--token-file', tokenFile], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function maskedFrame(payload, { opcode = 1, fin = true, rsv = 0, mask = true, declaredLength = null } = {}) {
  const body = Buffer.from(payload ?? '');
  const length = declaredLength ?? body.length;
  const maskKey = randomBytes(4);
  const encoded = Buffer.from(body);
  if (mask) for (let i = 0; i < encoded.length; i += 1) encoded[i] ^= maskKey[i % 4];
  let header;
  const first = (fin ? 0x80 : 0) | rsv | opcode;
  if (length < 126) header = Buffer.from([first, (mask ? 0x80 : 0) | length]);
  else if (length < 65536) { header = Buffer.alloc(4); header[0] = first; header[1] = (mask ? 0x80 : 0) | 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[0] = first; header[1] = (mask ? 0x80 : 0) | 127; header.writeBigUInt64BE(BigInt(length), 2); }
  return Buffer.concat([header, ...(mask ? [maskKey] : []), encoded]);
}

async function waitForToken() {
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(tokenFile)) {
      const token = readFileSync(tokenFile, 'utf8').trim();
      if (token) return token;
    }
    await sleep(50);
  }
  throw new Error('bridge token 未生成');
}

async function malformedConnection(token, payload) {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString('base64');
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write([
        `GET /ws?token=${encodeURIComponent(token)} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'));
    });
    let handshake = Buffer.alloc(0);
    let upgraded = false;
    let sent = false;
    const finish = (result) => {
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ upgraded, closed: false, timeout: true }), 2500);
    socket.on('data', (chunk) => {
      if (upgraded) return;
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end < 0) return;
      upgraded = handshake.subarray(0, end).toString('latin1').startsWith('HTTP/1.1 101');
      if (upgraded && !sent) {
        sent = true;
        socket.write(payload);
        // 计时从"帧已发出"开始：半截帧要靠桥接侧的空闲超时（WS_FRAME_IDLE_MS=1500ms）才会被断，
        // 握手本身耗时（机器忙时可达数百毫秒）不能算进这 2.5 秒预算里，否则 CI 上会偶发失败。
        timer.refresh();
      }
    });
    socket.on('close', () => finish({ upgraded, closed: true }));
    socket.on('error', () => finish({ upgraded, closed: true, error: true }));
  });
}

/** 令牌文件出现 ≠ 桥接已在监听（令牌在模块初始化时就写了，早于 server.listen）。 */
async function waitForReady(token, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 200) return true;
    } catch { /* 还没开始监听 */ }
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

const token = await waitForToken();
check('桥接已就绪（在监听，而不只是令牌已生成）', await waitForReady(token), `port=${port}`);
const cases = [
  ['半截 header 超时断开', Buffer.from([0x81])],
  ['声明长度恰好达到上限但不发送 body 时断开', maskedFrame('', { declaredLength: MAX_FRAME_BYTES })],
  ['声明长度超过上限立即断开', maskedFrame('', { declaredLength: MAX_FRAME_BYTES + 1 })],
  ['控制帧超长断开', maskedFrame(Buffer.alloc(126), { opcode: 9 })],
  ['客户端未 mask 断开', maskedFrame('x', { mask: false })],
  ['RSV 保留位断开', maskedFrame('x', { rsv: 0x40 })],
  ['分片消息断开', maskedFrame('x', { fin: false })],
  ['非法 JSON 断开', maskedFrame('{not-json')],
  ['JSON flood 断开', Buffer.concat(Array.from({ length: 100 }, () => maskedFrame('{bad')))],
];

for (const [label, payload] of cases) {
  const result = await malformedConnection(token, payload);
  check(label, result.upgraded && (result.closed || result.error), JSON.stringify(result));
}

const alive = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${token}` } }).then((res) => res.json()).catch(() => null);
check('所有畸形帧之后桥接仍能响应 /status', alive && alive.connected === false, JSON.stringify(alive));

try { child.kill(); } catch { /* ignore */ }
rmSync(workDir, { recursive: true, force: true });
console.log(`\n${failures ? `✗ ${failures} 个失败` : '✓ WebSocket fuzz 测试通过'}`);
process.exit(failures ? 1 : 0);
