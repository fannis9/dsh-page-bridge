#!/usr/bin/env node
/**
 * native-framing-test.mjs — exercise the native messaging transport without Chrome.
 *
 * Chrome talks to a native host with 4-byte little-endian length prefixes over stdio, so
 * a plain child process with pipes is a faithful stand-in. Two paths are covered:
 *
 *   host mode  : bridge --native owns the port and answers the native channel
 *   relay mode : another bridge already owns the port → native host relays frames to it
 *
 *   node dev/native-framing-test.mjs
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（本文件在 dev/ 下，往上一级） */
const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST_PORT = 8796;
const RELAY_PORT = 8797;
const children = [];
let failures = 0;

const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail && !ok ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* --------------------------------------------------------- native framing io */

function nativeChannel(child) {
  const state = { buffer: Buffer.alloc(0), queue: [], waiters: [] };
  child.stdout.on('data', (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    for (;;) {
      if (state.buffer.length < 4) break;
      const length = state.buffer.readUInt32LE(0);
      if (state.buffer.length < 4 + length) break;
      const payload = state.buffer.subarray(4, 4 + length);
      state.buffer = state.buffer.subarray(4 + length);
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
      const waiter = state.waiters.shift();
      if (waiter) waiter(msg);
      else state.queue.push(msg);
    }
  });

  const send = (obj) => {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    child.stdin.write(Buffer.concat([header, payload]));
  };

  const next = (timeoutMs = 3000) => new Promise((resolve) => {
    if (state.queue.length) { resolve(state.queue.shift()); return; }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    state.waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
  });

  /** Wait for the first frame matching `predicate`, skipping the rest (hello-ack etc.). */
  const nextWhere = async (predicate, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const msg = await next(remaining);
      if (!msg) return null;
      if (predicate(msg)) return msg;
    }
  };

  return { send, next, nextWhere };
}

function startChild(args, { piped = true } = {}) {
  const child = spawn(process.execPath, args, {
    stdio: piped ? ['pipe', 'pipe', 'inherit'] : ['ignore', 'ignore', 'inherit'],
  });
  children.push(child);
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* ------------------------------------------------------------- host mode test */

console.log('--- host 模式（Chrome 直接拉起 --native 桥接） ---');
const host = startChild([`${HERE}/bridge.mjs`, '--native', '--port', String(HOST_PORT), '--log', `${HERE}/var/native-test-${HOST_PORT}.jsonl`]);
const hostChannel = nativeChannel(host);
await sleep(700);

hostChannel.send({ type: 'hello', agent: 'chrome-extension', version: 'test', via: 'native' });
const ack = await hostChannel.nextWhere((m) => m.type === 'hello-ack');
check('收到 hello-ack（framing 双向可用）', ack?.type === 'hello-ack', JSON.stringify(ack));

const hostCmdPromise = post(HOST_PORT, { name: 'ping', args: {}, waitMs: 2000, timeoutMs: 4000 });
const cmdFrame = await hostChannel.nextWhere((m) => m.type === 'cmd');
check('HTTP /cmd 变成 native cmd 帧', cmdFrame?.type === 'cmd' && cmdFrame.name === 'ping', JSON.stringify(cmdFrame));
hostChannel.send({ type: 'result', id: cmdFrame?.id, ok: true, result: { pong: 'native-ok' } });
const hostResult = await hostCmdPromise;
check('native 回包被 HTTP 调用方收到', hostResult.body?.result?.pong === 'native-ok', JSON.stringify(hostResult.body));

const status = await (await fetch(`http://127.0.0.1:${HOST_PORT}/status`)).json();
check('/status 标出 native 与传输方式', status.native === true && status.clients.some((c) => c.via === 'native'), JSON.stringify(status.clients));

/* ------------------------------------------------------------ relay mode test */

console.log('\n--- relay 模式（端口已被按需桥接占用时降级为中继） ---');
startChild([`${HERE}/bridge.mjs`, '--port', String(RELAY_PORT), '--log', `${HERE}/var/native-test-${RELAY_PORT}.jsonl`], { piped: false });
await sleep(700);
const relay = startChild([`${HERE}/bridge.mjs`, '--native', '--port', String(RELAY_PORT), '--log', `${HERE}/var/native-test-${RELAY_PORT}.jsonl`]);
const relayChannel = nativeChannel(relay);
await sleep(900);

relayChannel.send({ type: 'hello', agent: 'chrome-extension', version: 'test', via: 'native' });
await sleep(300);
const relayCmdPromise = post(RELAY_PORT, { name: 'state', args: {}, waitMs: 2000, timeoutMs: 4000 });
const relayCmd = await relayChannel.nextWhere((m) => m.type === 'cmd');
check('中继把 cmd 帧转给了 native 侧', relayCmd?.type === 'cmd' && relayCmd.name === 'state', JSON.stringify(relayCmd));
relayChannel.send({ type: 'result', id: relayCmd?.id, ok: true, result: { viaRelay: true } });
const relayResult = await relayCmdPromise;
check('中继回包到达 HTTP 调用方', relayResult.body?.result?.viaRelay === true, JSON.stringify(relayResult.body));

/* ------------------------------------------------------------------- cleanup */

for (const child of children) { try { child.kill(); } catch { /* ignore */ } }
for (const port of [HOST_PORT, RELAY_PORT]) rmSync(`${HERE}/var/native-test-${port}.jsonl`, { force: true });
console.log(`\n${failures ? `✗ ${failures} 个断言失败` : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
