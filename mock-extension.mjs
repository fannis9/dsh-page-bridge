#!/usr/bin/env node
/**
 * mock-extension.mjs — stands in for the Chrome extension so the bridge and the CLI
 * can be tested without a browser. Answers a few commands with canned data.
 *
 *   node mock-extension.mjs [--port 8799]
 */
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(flag('port', 8799));

const key = randomBytes(16).toString('base64');

const handshake = request({
  host: '127.0.0.1',
  port: PORT,
  path: '/ws',
  headers: {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': key,
    'sec-websocket-version': '13',
  },
});

const encodeText = (text) => {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
};

const decode = (state, chunk) => {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  const out = [];
  for (;;) {
    const buf = state.buffer;
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (buf.length < 4) break; length = buf.readUInt16BE(2); offset = 4; }
    let mask = null;
    if (masked) { if (buf.length < offset + 4) break; mask = buf.subarray(offset, offset + 4); offset += 4; }
    if (buf.length < offset + length) break;
    const payload = Buffer.from(buf.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    state.buffer = buf.subarray(offset + length);
    out.push({ opcode, payload });
  }
  return out;
};

const CANNED_STATE = {
  url: 'https://example.com/mock',
  title: 'Mock 页面（用于自检）',
  headings: [{ level: 1, text: 'Mock 标题' }],
  forms: [{ tag: 'input', type: 'text', id: 'q' }],
  scroll: { y: 0, height: 1200, viewport: 900 },
  text: '这是 mock 扩展返回的正文，用来验证 bridge → CLI 链路。',
};

const CANNED_SNAPSHOT = {
  url: CANNED_STATE.url,
  title: CANNED_STATE.title,
  yaml: [
    '- main',
    '  - heading "Mock 标题" [level=1]',
    '  - form',
    '    - textbox "关键词" [ref=e1]',
    '    - button "提交" [ref=e2]',
  ].join('\n'),
  nodes: 4,
  refs: 2,
  truncated: false,
};

handshake.on('upgrade', (res, socket) => {
  if (res.headers['sec-websocket-accept'] !== createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')) {
    console.error('mock: bad handshake');
    process.exit(1);
  }
  console.log('mock-extension: connected to bridge');
  const state = { buffer: Buffer.alloc(0) };
  socket.write(encodeText(JSON.stringify({ type: 'hello', agent: 'chrome-extension', version: 'mock' })));
  socket.write(encodeText(JSON.stringify({ type: 'event', name: 'tab-activated', ts: Date.now(), tab: { id: 1, url: CANNED_STATE.url, title: CANNED_STATE.title } })));

  socket.on('data', (chunk) => {
    for (const frame of decode(state, chunk)) {
      if (frame.opcode !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
      if (msg.type === 'cmd') {
        let result;
        if (msg.name === 'ping') result = { pong: true };
        else if (msg.name === 'tabs') result = [{ id: 1, windowId: 1, active: true, url: CANNED_STATE.url, title: CANNED_STATE.title }];
        else if (msg.name === 'state') result = CANNED_STATE;
        else if (msg.name === 'text') result = { url: CANNED_STATE.url, title: CANNED_STATE.title, length: CANNED_STATE.text.length, text: CANNED_STATE.text };
        else if (msg.name === 'snapshot') result = CANNED_SNAPSHOT;
        else result = { mock: true, name: msg.name, args: msg.args };
        socket.write(encodeText(JSON.stringify({ type: 'result', id: msg.id, ok: true, result })));
      }
    }
  });
  socket.on('close', () => { console.log('mock-extension: disconnected'); process.exit(0); });
});

handshake.on('error', (error) => { console.error('mock: cannot reach bridge:', error.message); process.exit(1); });
handshake.end();
