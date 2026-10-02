#!/usr/bin/env node
/**
 * bridge-auth-test.mjs —— 验证本地控制面的能力令牌（不需要浏览器，可进 CI）。
 *
 * 背景（外部评审的重点一条）：127.0.0.1 不是信任边界。原来的 bridge 谁都能连：
 *   - 任意本机进程可 POST /cmd 直接驱动用户的浏览器；
 *   - 任意本机进程可 GET /events /state 读到页面元数据；
 *   - 更糟：native host 在端口被占用时会 relay 到"谁占着端口"，把 Chrome 认证过的通道交出去。
 *
 * 本测试逐条验证这些路径现在都要求令牌，且 relay 在对方拿不出令牌时**失败关闭**（fail closed）。
 *
 *   node dev/bridge-auth-test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BRIDGE = join(ROOT, 'bridge.mjs');
const NODE = process.execPath;
const PORT = Number(process.env.TEST_PORT ?? 8796);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workDir = mkdtempSync(join(tmpdir(), 'bridge-auth-'));
const TOKEN_FILE = join(workDir, 'token');

const bridge = spawn(NODE, [BRIDGE, '--port', String(PORT), '--idle-exit', '0', '--token-file', TOKEN_FILE], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (d) => { bridgeLog += d; });
bridge.stderr.on('data', (d) => { bridgeLog += d; });

const cleanup = () => {
  try { bridge.kill(); } catch { /* ignore */ }
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

const base = `http://127.0.0.1:${PORT}`;
const get = async (path, token) => {
  try {
    const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (error) {
    return { status: 0, error: String(error?.message ?? error) };
  }
};
const post = async (path, payload, token) => {
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload ?? {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (error) {
    return { status: 0, error: String(error?.message ?? error) };
  }
};

// 等桥接起来并生成令牌
let token = null;
for (let i = 0; i < 40; i += 1) {
  if (existsSync(TOKEN_FILE)) {
    token = readFileSync(TOKEN_FILE, 'utf8').trim();
    const probe = await get('/status', token);
    if (probe.status === 200) break;
  }
  await sleep(150);
}

console.log('=== 环境 ===');
console.log(`  端口 ${PORT} / 令牌文件 ${TOKEN_FILE}`);
console.log(`  令牌长度 ${token ? token.length : 0}${token ? `（${token.slice(0, 8)}…）` : ''}`);
check('桥接启动并生成了令牌文件', Boolean(token) && token.length >= 32, `token=${token}`);
check('令牌不是可猜的短串（>=32 字符）', (token ?? '').length >= 32, String(token?.length));

console.log('\n=== 1. 无令牌访问必须被拒 ===');
for (const path of ['/status', '/events', '/state']) {
  const res = await get(path);
  check(`GET ${path} 无令牌 → 401`, res.status === 401, JSON.stringify(res));
}
const cmdNoToken = await post('/cmd', { name: 'state', args: {} });
check('POST /cmd 无令牌 → 401', cmdNoToken.status === 401, JSON.stringify(cmdNoToken));
const shutdownNoToken = await post('/shutdown', {});
check('POST /shutdown 无令牌 → 401', shutdownNoToken.status === 401, JSON.stringify(shutdownNoToken));

console.log('\n=== 2. 伪造/错误令牌也不行 ===');
const bogus = await get('/status', randomBytes(32).toString('hex'));
check('错误令牌 → 401', bogus.status === 401, JSON.stringify(bogus));
const shortBogus = await post('/cmd', { name: 'state', args: {} }, 'x');
check('短假令牌 → 401', shortBogus.status === 401, JSON.stringify(shortBogus));

console.log('\n=== 3. 带上正确令牌则正常 ===');
const okStatus = await get('/status', token);
check('GET /status 带令牌 → 200', okStatus.status === 200, JSON.stringify(okStatus).slice(0, 200));
check('/status 显示配置文件里没有令牌泄露', !JSON.stringify(okStatus.body ?? {}).includes(token), 'body 里出现了令牌！');
const okCmd = await post('/cmd', { name: 'state', args: {}, waitMs: 300, timeoutMs: 800 }, token);
// 没有扩展连着，所以是 503 而不是 200 —— 关键是"认证通过了、命令真的被派发"，而不是 401
check('POST /cmd 带令牌 → 认证通过（非 401）', okCmd.status !== 401, JSON.stringify(okCmd).slice(0, 200));

console.log('\n=== 4. WS 握手同样需要令牌 ===');
const wsProbe = (query) => new Promise((resolve) => {
  const req = fetch(`${base}/ws${query}`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13' } });
  const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 2500);
  req.then((res) => { clearTimeout(timer); resolve({ outcome: 'http', status: res.status }); })
    .catch((error) => { clearTimeout(timer); resolve({ outcome: 'error', message: String(error?.message ?? error) }); });
});
const wsNoToken = await wsProbe('');
check('WS 无令牌 → 被拒（401 或连接被断）', wsNoToken.outcome !== 'timeout' && (wsNoToken.status === 401 || wsNoToken.outcome === 'error'), JSON.stringify(wsNoToken));
const wsBadToken = await wsProbe('?token=deadbeef');
check('WS 错令牌 → 被拒', wsBadToken.outcome !== 'timeout' && (wsBadToken.status === 401 || wsBadToken.outcome === 'error'), JSON.stringify(wsBadToken));

console.log('\n=== 5. relay challenge 本身也必须认证，且抗 nonce 刷写 ===');
const challengeNoToken = await get('/relay-challenge');
check('relay challenge 无令牌 → 401', challengeNoToken.status === 401, JSON.stringify(challengeNoToken));
const challengeWithToken = await get('/relay-challenge', token);
const relayNonce = challengeWithToken.body?.nonce;
check('relay challenge 带令牌 → 返回合法 nonce', challengeWithToken.status === 200 && /^[0-9a-f]{64}$/.test(relayNonce ?? ''), JSON.stringify(challengeWithToken));
const flood = await Promise.all(Array.from({ length: 200 }, () => get('/relay-challenge')));
check('连续 200 次无令牌请求全部被拒', flood.every((res) => res.status === 401), `statuses=${[...new Set(flood.map((res) => res.status))].join(',')}`);

const relayHandshake = await new Promise((resolve) => {
  const key = randomBytes(16).toString('base64');
  const req = request({
    host: '127.0.0.1',
    port: PORT,
    path: '/ws',
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
      'x-bridge-relay-nonce': relayNonce,
      'x-bridge-relay-proof': createHmac('sha256', token).update(`relay-client:${relayNonce}`).digest('hex'),
    },
  });
  const timer = setTimeout(() => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); }, 2500);
  req.on('upgrade', (res, socket, head) => {
    clearTimeout(timer);
    let buffer = head ?? Buffer.alloc(0);
    const read = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const firstLength = buffer[1] & 0x7f;
      let offset = 2;
      let length = firstLength;
      if (firstLength === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (firstLength === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      try {
        resolve({ ok: res.statusCode === 101 && JSON.parse(buffer.subarray(offset, offset + length).toString('utf8'))?.type === 'relay-auth-ok' });
      } catch (error) {
        resolve({ ok: false, reason: String(error?.message ?? error) });
      } finally {
        socket.destroy();
      }
    };
    socket.on('data', read);
    if (buffer.length) read(Buffer.alloc(0));
  });
  req.on('response', (res) => { clearTimeout(timer); res.resume(); resolve({ ok: false, reason: `HTTP ${res.statusCode}` }); });
  req.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, reason: String(error?.message ?? error) }); });
  req.end();
});
check('刷写后合法 relay 仍能完成握手', relayHandshake.ok, JSON.stringify(relayHandshake));

console.log('\n=== 6. 端口被陌生人占用时：native host 必须失败关闭（这是最关键的一条） ===');
// 模拟攻击者：先绑住端口，且它拿不出令牌（因为它读不到令牌文件）
const squatter = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"impostor":true}');
});
await new Promise((resolve) => squatter.listen(PORT + 1, '127.0.0.1', resolve));

const nativeHost = spawn(NODE, [BRIDGE, '--native', '--port', String(PORT + 1), '--token-file', join(workDir, 'other-token')], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let nativeOut = '';
nativeHost.stdout.on('data', (d) => { nativeOut += d; });
let nativeErr = '';
nativeHost.stderr.on('data', (d) => { nativeErr += d; });
// 给扩展的 hello（native 帧：4 字节小端长度 + JSON）
const hello = Buffer.from(JSON.stringify({ type: 'hello', agent: 'chrome-extension', browser: 'chrome' }));
const frame = Buffer.alloc(4);
frame.writeUInt32LE(hello.length, 0);
nativeHost.stdin.write(Buffer.concat([frame, hello]));

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 6000);
  nativeHost.on('exit', (code) => { clearTimeout(timer); resolve(code); });
});
squatter.close();
check('对方拿不出令牌时 native host 退出（不 relay）', exitCode !== 0 && exitCode !== 'timeout', `exitCode=${exitCode} log=${nativeErr.slice(0, 300)}`);
check('日志说明了拒绝原因', /refused|401|unauthenticated|invalid relay nonce/i.test(nativeErr), nativeErr.slice(0, 300));
check('没有把 hello 转发给占端口的人', !nativeOut.includes('hello-ack'), nativeOut.slice(0, 200));

console.log('\n=== 7. 恶意端口占用者即使返回 101 也不能接管 relay ===');
await new Promise((resolve) => squatter.close(resolve));
const attackerNonce = 'a'.repeat(64);
let attackerUpgradePath = '';
let attackerSawHello = false;
const attackerSockets = new Set();
const attacker = createServer((req, res) => {
  if (req.url === '/relay-challenge') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ nonce: attackerNonce }));
    return;
  }
  res.writeHead(404).end();
});
attacker.on('upgrade', (req, socket) => {
  attackerSockets.add(socket);
  socket.on('close', () => attackerSockets.delete(socket));
  attackerUpgradePath = String(req.url ?? '');
  const wsKey = String(req.headers['sec-websocket-key'] ?? '');
  const accept = createHash('sha1').update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));
  const fake = Buffer.from(JSON.stringify({ type: 'relay-auth-ok', nonce: attackerNonce, proof: '0'.repeat(64) }));
  socket.write(Buffer.concat([Buffer.from([0x81, fake.length]), fake]));
  socket.on('data', (chunk) => { if (chunk.includes(Buffer.from('hello'))) attackerSawHello = true; });
});
await new Promise((resolve) => attacker.listen(PORT + 1, '127.0.0.1', resolve));
const hostileNative = spawn(NODE, [BRIDGE, '--native', '--port', String(PORT + 1), '--token-file', join(workDir, 'other-token-2')], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let hostileOut = '';
hostileNative.stdout.on('data', (d) => { hostileOut += d; });
hostileNative.stdin.write(Buffer.concat([frame, hello]));
const hostileExit = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 6000);
  hostileNative.on('exit', (code) => { clearTimeout(timer); resolve(code); });
});
check('恶意 101 relay 最终失败关闭', hostileExit !== 0 && hostileExit !== 'timeout', `exitCode=${hostileExit}`);
check('relay URL 不泄露能力令牌', !attackerUpgradePath.includes(token), attackerUpgradePath);
check('伪造服务端证明不会收到 native hello', !attackerSawHello && !hostileOut.includes('hello-ack'), hostileOut.slice(0, 200));
for (const socket of attackerSockets) socket.destroy();
await new Promise((resolve) => attacker.close(resolve));

console.log('\n=== 桥接日志（末 400 字符）===');
console.log(bridgeLog.slice(-400));

cleanup();
console.log(`\n${failures ? `✗ ${failures} 个断言失败` : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
