#!/usr/bin/env node
/**
 * smoke-snapshot.mjs — verify the BrowserMCP-style wiring end to end, without a browser
 * and WITHOUT touching your real one.
 *
 * Isolation matters: this script starts its own bridge + fake extension on a separate
 * port (default 8798) and points the MCP server at it, so it can never reach the real
 * extension that is listening on 8799.
 *
 *   node dev/smoke-snapshot.mjs [--port 8798]
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const HERE = 'E:/dsh/page-bridge';
const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const PORT = Number(portIndex >= 0 && argv[portIndex + 1] ? argv[portIndex + 1] : 8798);
const LOG = `${HERE}/var/smoke-${PORT}.jsonl`;
const env = { ...process.env, PAGE_BRIDGE_PORT: String(PORT) };

const children = [];
const start = (label, args, stdio = 'ignore') => {
  const child = spawn(process.execPath, args, { stdio, env });
  children.push(child);
  return child;
};

const bridge = start('bridge', [`${HERE}/bridge.mjs`, '--port', String(PORT), '--log', LOG]);
const mock = start('mock', [`${HERE}/mock-extension.mjs`, '--port', String(PORT)]);
const server = start('mcp', [`${HERE}/mcp-server.mjs`], ['pipe', 'pipe', 'inherit']);

const cleanup = () => {
  for (const child of children) { try { child.kill(); } catch { /* ignore */ } }
  try { rmSync(LOG, { force: true }); } catch { /* ignore */ }
};

// wait for the bridge to accept connections
for (let i = 0; i < 40; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`);
    if (res.ok) break;
  } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 150));
}

let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === 2) {
      console.log(`tools/list → ${message.result.tools.length} 个工具`);
      continue;
    }
    const text = message.result?.content?.map((c) => (c.type === 'image' ? '[image]' : c.text)).join('\n');
    console.log(`\n----- id=${message.id} -----\n${text ?? JSON.stringify(message.error)}`);
  }
});

const send = (o) => server.stdin.write(`${JSON.stringify(o)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'page_snapshot', arguments: {} } }), 700);
setTimeout(() => send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'page_click', arguments: { ref: 'e5' } } }), 1600);
setTimeout(() => send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'page_type', arguments: { selector: '#q', text: 'hello' } } }), 2600);
setTimeout(() => { cleanup(); process.exit(0); }, 4200);

process.on('SIGINT', () => { cleanup(); process.exit(0); });
