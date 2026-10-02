#!/usr/bin/env node
/**
 * smoke-mcp.mjs — smoke-test the MCP server over stdio without involving DSH.
 *
 * Starts its own bridge + fake extension on an isolated port (default 8798) so it can
 * never talk to the real extension listening on 8799.
 *
 *   node smoke-mcp.mjs [--port 8798]
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（本文件所在目录），保证仓库放到任何路径都能跑 */
const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const PORT = Number(portIndex >= 0 && argv[portIndex + 1] ? argv[portIndex + 1] : 8798);
const LOG = `${HERE}/var/smoke-${PORT}.jsonl`;
const env = { ...process.env, PAGE_BRIDGE_PORT: String(PORT) };

const children = [];
const start = (args, stdio = 'ignore') => {
  const child = spawn(process.execPath, args, { stdio, env });
  children.push(child);
  return child;
};

start([`${HERE}/bridge.mjs`, '--port', String(PORT), '--log', LOG]);
start([`${HERE}/mock-extension.mjs`, '--port', String(PORT)]);
const server = start([`${HERE}/mcp-server.mjs`], ['pipe', 'pipe', 'inherit']);

const cleanup = () => {
  for (const child of children) { try { child.kill(); } catch { /* ignore */ } }
  try { rmSync(LOG, { force: true }); } catch { /* ignore */ }
};

for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/status`)).ok) break; } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 150));
}

const seen = [];
let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    seen.push(message);
    if (message.id === 2) console.log('tools/list ->', message.result.tools.length, 'tools:', message.result.tools.map((t) => t.name).join(','));
    else console.log(`<< id=${message.id}`, JSON.stringify(message.result ?? message.error).slice(0, 500));
  }
});

const send = (o) => server.stdin.write(`${JSON.stringify(o)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
setTimeout(() => send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'page_status', arguments: {} } }), 600);
setTimeout(() => send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'page_state', arguments: { maxText: 200 } } }), 1500);

setTimeout(() => { cleanup(); process.exit(0); }, 3500);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
