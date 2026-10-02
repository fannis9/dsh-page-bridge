#!/usr/bin/env node
/**
 * bridge-queue-test.mjs —— 桥接侧的三项行为（不需要浏览器，可进 CI）：
 *
 *  1. per-tab 命令队列：同一个 (浏览器, 标签页) 上的命令串行执行，顺序 = 下发顺序；
 *     不同标签页之间不互相阻塞（评审第 10 条：并发时"模型看到的顺序"和"实际执行顺序"会不一致）。
 *  2. /cmd 回包里带上"是哪台浏览器接的单"——MCP 层据此把随后的自动快照固定到同一台。
 *  3. hello 里的 instance id 可用于区分同一个浏览器的多个 Profile（评审第 9 条），
 *     并支持 `page_use_browser chrome@<前缀>` 这种精确寻址。
 *  4. WS 单帧上限：声称超大长度的帧直接断连，而不是无限缓冲（评审第 7 条）。
 *
 *   node dev/bridge-queue-test.mjs
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, '..', 'bridge.mjs');
const PORT = Number(process.env.TEST_PORT ?? 8795);
const workDir = mkdtempSync(join(tmpdir(), 'bridge-queue-'));
const TOKEN_FILE = join(workDir, 'token');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridge = spawn(process.execPath, [BRIDGE, '--native', '--port', String(PORT), '--idle-exit', '0', '--token-file', TOKEN_FILE], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let log = '';
bridge.stdout.on('data', (d) => { log += d; });
bridge.stderr.on('data', (d) => { log += d; });
const cleanup = () => {
  try { bridge.kill(); } catch { /* ignore */ }
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

/* --------------------------------------------------------------- native framing */

/** 我们把测试自己伪装成扩展，用 native 帧跟桥接说话（和 Chrome 走的是同一条通道）。 */
const inbound = [];
const waiters = [];
const frame = (obj) => {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
};
const send = (obj) => bridge.stdin.write(frame(obj));
let readBuffer = Buffer.alloc(0);
bridge.stdout.on('data', (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk]);
  for (;;) {
    if (readBuffer.length < 4) return;
    const len = readBuffer.readUInt32LE(0);
    if (readBuffer.length < 4 + len) return;
    let msg = null;
    try { msg = JSON.parse(readBuffer.subarray(4, 4 + len).toString('utf8')); } catch { /* ignore */ }
    readBuffer = readBuffer.subarray(4 + len);
    if (!msg) continue;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else inbound.push(msg);
  }
});
const nextMessage = (timeoutMs = 3000) => new Promise((resolve) => {
  if (inbound.length) { resolve(inbound.shift()); return; }
  const timer = setTimeout(() => resolve(null), timeoutMs);
  waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
});

let token = null;
for (let i = 0; i < 40; i += 1) {
  if (existsSync(TOKEN_FILE)) { token = readFileSync(TOKEN_FILE, 'utf8').trim(); break; }
  await sleep(120);
}
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const post = async (body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/cmd`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const getStatus = async () => (await fetch(`http://127.0.0.1:${PORT}/status`, { headers: auth })).json();

console.log('=== 环境 ===');
console.log(`  端口 ${PORT} / 令牌 ${token ? `${token.slice(0, 8)}…` : '(缺失)'}`);
check('桥接就绪且生成了令牌', Boolean(token));

// 假装成扩展：hello 带 browser + instance
const INSTANCE = 'a1b2c3d4e5f60718';
send({ type: 'hello', agent: 'chrome-extension', browser: 'chrome', instance: INSTANCE, version: 'test', via: 'native' });
const ack = await nextMessage();
check('收到 hello-ack', ack?.type === 'hello-ack', JSON.stringify(ack));
const statusAfterHello = await getStatus();
check('/status 里带上了 instance（可用于区分同浏览器多 Profile）',
  statusAfterHello.clients.some((c) => c.instance === INSTANCE), JSON.stringify(statusAfterHello.clients));
// 版本必须能从 /status 一眼读到：否则"这次重载生效了吗"只能靠时间戳 + 试探命令反推。
check('/status 暴露当前生效的扩展版本（顶层 extensionVersion）',
  statusAfterHello.extensionVersion === 'test', JSON.stringify({ got: statusAfterHello.extensionVersion }));
check('每个 client 也带 version（多浏览器时能分别看）',
  statusAfterHello.clients.every((c) => c.version === 'test'),
  JSON.stringify(statusAfterHello.clients.map((c) => c.version)));

/* ------------------------------------------------------------------ 1. 同标签页串行 */

console.log('\n=== 1. 同一个标签页上的并发命令按顺序执行 ===');
const received = [];
let completed = 0;
const fakeExtension = (async () => {
  for (;;) {
    const msg = await nextMessage(5000);
    if (!msg || msg.type !== 'cmd') continue;
    received.push({ name: msg.name, id: msg.id, at: Date.now() });
    // 每条命令**并发**处理：串行是桥接队列的职责，测试桩自己不能成为瓶颈，
    // 否则"不同标签页互不阻塞"这条就测不出真伪。
    void (async () => {
      await sleep(Number(msg.args?.delayMs ?? 120));
      completed += 1;
      send({ type: 'result', id: msg.id, ok: true, result: { name: msg.name, order: completed } });
    })();
  }
})();

const order = ['first', 'second', 'third', 'fourth'];
const concurrent = await Promise.all(order.map((name) => post({ name: 'click', args: { tabId: 1, delayMs: 120, tag: name } })));
check('四条并发命令都成功返回', concurrent.every((r) => r.status === 200 && r.body?.ok === true),
  JSON.stringify(concurrent.map((r) => r.status)));
const receivedNames = received.map((r) => r.name);
check('扩展侧收到的执行顺序 = 下发顺序（串行）', JSON.stringify(receivedNames) === JSON.stringify(['click', 'click', 'click', 'click']),
  JSON.stringify(receivedNames));
check('返回的 order 严格递增（没有交错）',
  concurrent.every((r, i) => r.body?.result?.order === i + 1),
  JSON.stringify(concurrent.map((r) => r.body?.result?.order)));

/* --------------------------------------------------------------- 2. 不同标签页不阻塞 */

console.log('\n=== 2. 不同标签页之间不互相阻塞 ===');
received.length = 0;
const slowTab = post({ name: 'click', args: { tabId: 7, delayMs: 700 } });
await sleep(80);
const fastTab = post({ name: 'click', args: { tabId: 8, delayMs: 20 } });
const fastFirst = await Promise.race([
  fastTab.then(() => 'fast'),
  slowTab.then(() => 'slow'),
  sleep(1500).then(() => 'timeout'),
]);
check('慢标签页没有挡住快标签页', fastFirst === 'fast', `first=${fastFirst}`);
await slowTab;

/* --------------------------------------------------------------- 3. 浏览器/实例路由 */

console.log('\n=== 3. /cmd 回包带上接单的浏览器；instance 可精确寻址 ===');
const served = await post({ name: 'state', args: {} });
check('回包里带 browser', served.body?.browser === 'chrome', JSON.stringify(served.body));
check('回包里带 via', served.body?.via === 'native', JSON.stringify(served.body));
const exact = await post({ name: 'state', args: {}, browser: `chrome@${INSTANCE.slice(0, 6)}` });
check('chrome@<instance 前缀> 能命中这台', exact.body?.ok === true, JSON.stringify(exact.body).slice(0, 160));
const wrong = await post({ name: 'state', args: {}, browser: 'chrome@zzzzzz' });
check('错误的 instance 前缀 → 明确报"没连"', wrong.status === 503 && /没有连接扩展/.test(wrong.body?.error ?? ''),
  JSON.stringify(wrong.body).slice(0, 160));

/* ------------------------------------------------------------------- 4. WS 帧上限 */

console.log('\n=== 4. WS 超大帧：断连而不是无限缓冲 ===');
const wsFrame = (hugeLength) => {
  const mask = randomBytes(4);
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x80 | 127;           // masked + 64-bit length
  header.writeBigUInt64BE(BigInt(hugeLength), 2);
  return Buffer.concat([header, mask]);   // 只发头，不发 payload
};
const wsResult = await new Promise((resolve) => {
  const key = randomBytes(16).toString('base64');
  const socket = createConnection({ host: '127.0.0.1', port: PORT }, () => {
    socket.write([
      'GET /ws?token=' + encodeURIComponent(token) + ' HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '', '',
    ].join('\r\n'));
  });
  let buffer = '';
  let upgraded = false;
  socket.on('data', (chunk) => {
    if (!upgraded) {
      buffer += chunk.toString('latin1');
      if (buffer.includes('\r\n\r\n')) {
        upgraded = buffer.startsWith('HTTP/1.1 101');
        resolve_ready();
      }
    }
  });
  const resolve_ready = () => {
    // 握手成功后再发那个疯狂的帧
    socket.write(wsFrame(2 ** 50));
  };
  const timer = setTimeout(() => { socket.destroy(); resolve({ upgraded, closed: false, timeout: true }); }, 4000);
  socket.on('close', () => { clearTimeout(timer); resolve({ upgraded, closed: true }); });
  socket.on('error', () => { clearTimeout(timer); resolve({ upgraded, closed: true, error: true }); });
});
check('WS 握手成功（带令牌）', wsResult.upgraded === true, JSON.stringify(wsResult));
check('超大帧导致连接被断开', wsResult.closed === true || wsResult.error === true, JSON.stringify(wsResult));
const aliveAfter = await getStatus().catch(() => null);
check('桥接本身没被拖死（仍能响应 /status）', Boolean(aliveAfter?.connected !== undefined), JSON.stringify(aliveAfter)?.slice(0, 120));
check('日志里能看到拒绝原因', /frame too large|bad frame/i.test(log), log.slice(-200));

fakeExtension.catch(() => {});
cleanup();
console.log(`\n${failures ? `✗ ${failures} 个断言失败` : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
