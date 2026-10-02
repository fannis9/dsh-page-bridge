#!/usr/bin/env node
/**
 * page.mjs — talk to the DSH Page Bridge from the command line.
 *
 *   node page.mjs status
 *   node page.mjs tabs
 *   node page.mjs state [--json] [--max-text 12000]
 *   node page.mjs text [--max 20000]
 *   node page.mjs html [--max 60000]
 *   node page.mjs eval "<js expression>" [--world MAIN]
 *   node page.mjs click "<selector|text=登录>"
 *   node page.mjs type "<selector>" "<text>" [--submit]
 *   node page.mjs select "<selector>" "<value>"
 *   node page.mjs scroll "<selector>" | --by 800
 *   node page.mjs highlight "<selector>"
 *   node page.mjs shot <out.png>
 *   node page.mjs navigate <url> | activate <tabId> | close <tabId>
 *   node page.mjs events [--limit 30]
 *   node page.mjs wait "<selector>" [--timeout 15000]
 *
 * Global flags: --tab <id> --port <n> --wait <ms> (wait for the extension) --timeout <ms> --json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  } else rest.push(arg);
}

const PORT = Number(flags.port ?? process.env.PAGE_BRIDGE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const command = rest[0];
const BRIDGE = fileURLToPath(new URL('./bridge.mjs', import.meta.url));

/** Is the bridge listening? */
async function bridgeAlive(timeoutMs = 900) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`${BASE}/status`, { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the bridge on demand: detached, hidden, no console — it outlives this call
 * and exits by itself after --idle-exit minutes without traffic.
 * @returns whether a new bridge was spawned
 */
async function ensureBridge() {
  if (flags['no-autostart']) return false;
  if (await bridgeAlive()) return false;
  console.error(`[page.mjs] 桥接未运行，正在启动…（端口 ${PORT}）`);
  const child = spawn(process.execPath, [BRIDGE, '--port', String(PORT)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await bridgeAlive()) {
      console.error('[page.mjs] 桥接已就绪');
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`桥接启动失败，请手动运行：node ${BRIDGE} --port ${PORT}`);
}

const call = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

let defaultWait = 8000;

const cmd = async (name, args = {}, extra = {}) => {
  const { status, body } = await call('/cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      args: { ...args, ...(flags.tab ? { tabId: Number(flags.tab) } : {}) },
      waitMs: Number(flags.wait ?? defaultWait),
      timeoutMs: Number(flags.timeout ?? 20000),
      ...extra,
    }),
  });
  if (status !== 200 || !body?.ok) throw new Error(body?.error ?? `bridge returned ${status}`);
  return body.result;
};

const out = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

function printState(state) {
  const lines = [];
  lines.push(`# ${state.title ?? ''}`);
  lines.push(state.url ?? '');
  if (state.lang) lines.push(`lang: ${state.lang}`);
  if (state.selection) lines.push(`\n[选中的文本]\n${state.selection}`);
  if (state.headings?.length) {
    lines.push('\n[标题结构]');
    for (const h of state.headings) lines.push(`${'  '.repeat(h.level - 1)}h${h.level} ${h.text}`);
  }
  if (state.forms?.length) {
    lines.push('\n[可交互元素]');
    for (const f of state.forms) {
      lines.push(`  <${f.tag}${f.type ? ` type=${f.type}` : ''}${f.id ? ` #${f.id}` : ''}${f.name ? ` name=${f.name}` : ''}> ${f.label ?? f.text ?? f.placeholder ?? ''}`.trimEnd());
    }
  }
  if (state.scroll) lines.push(`\n[滚动] y=${state.scroll.y} / 文档高 ${state.scroll.height}，视口 ${state.scroll.viewport}`);
  lines.push('\n[正文]');
  lines.push(state.text ?? '');
  return lines.join('\n');
}

if (!command || command === 'help' || flags.help) {
  console.log('commands: status | grant | tabs | state | snapshot | text | html | eval | click | type | select | scroll | highlight | shot | open | navigate | activate | close | events | wait | stop');
  process.exit(command ? 0 : 1);
}

if (command === 'stop') {
  if (!(await bridgeAlive())) {
    console.log('桥接本来就没在运行');
  } else {
    const { body } = await call('/shutdown', { method: 'POST' });
    console.log(body?.ok ? '桥接已停止（下次需要时我会自动拉起）' : `停止失败：${JSON.stringify(body)}`);
  }
  process.exit(0);
}

// Start the bridge on demand; give the extension more slack when we just spawned it.
const startedNow = await ensureBridge();
defaultWait = startedNow ? 30_000 : 8000;

try {
  if (command === 'status') {
    // Right after an on-demand start (or with an explicit --wait) the extension may need
    // a few seconds to reconnect — its worker can be suspended by Chrome while idle.
    if (startedNow || flags.wait) {
      const deadline = Date.now() + Number(flags.wait ?? 15000);
      while (Date.now() < deadline) {
        const { body } = await call('/status');
        if (body?.extensionConnected) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    out((await call('/status')).body);
  } else if (command === 'events') {
    const limit = Number(flags.limit ?? 30);
    const { body } = await call(`/events?limit=${limit}`);
    for (const e of body.events ?? []) {
      const when = new Date(e.ts).toLocaleTimeString();
      console.log(`${when}  ${e.name.padEnd(14)} ${e.tab?.title ?? ''}  ${e.tab?.url ?? ''}`);
    }
    if (!body.events?.length) console.log('(还没有事件；扩展连上后切换/加载标签页就会记录)');
  } else if (command === 'grant') {
    out(await cmd('grant', {}, { timeoutMs: 10_000 }));
  } else if (command === 'tabs') {
    const tabs = await cmd('tabs');
    for (const t of tabs) console.log(`${t.active ? '*' : ' '} [${t.id}] ${t.title ?? ''}  ${t.url ?? ''}`);
  } else if (command === 'state') {
    const state = await cmd('state', { maxText: Number(flags['max-text'] ?? 12000) });
    if (flags.json) out(state); else console.log(printState(state));
  } else if (command === 'snapshot') {
    const snap = await cmd('snapshot', {
      selector: flags.selector,
      maxNodes: Number(flags['max-nodes'] ?? 500),
      maxDepth: Number(flags['max-depth'] ?? 14),
    });
    if (snap?.ok === false) throw new Error(snap.reason ?? '快照失败');
    if (flags.json) { out(snap); } else {
      console.log(`- Page URL: ${snap.url}`);
      console.log(`- Page Title: ${snap.title}`);
      console.log('- Page Snapshot');
      console.log('```yaml');
      console.log(snap.yaml);
      console.log('```');
      console.error(`[page.mjs] 节点 ${snap.nodes} / ref ${snap.refs}${snap.truncated ? ' / 已截断' : ''}`);
    }
  } else if (command === 'text') {
    const res = await cmd('text', { max: Number(flags.max ?? 20000) });
    console.log(res.text ?? '');
    if (res.length > (res.text?.length ?? 0)) console.log(`\n... 已截断（原长 ${res.length} 字符，用 --max 调大）`);
  } else if (command === 'html') {
    const res = await cmd('html', { max: Number(flags.max ?? 60000) });
    console.log(res.html ?? '');
  } else if (command === 'eval') {
    out(await cmd('eval', { code: rest[1] ?? '', ...(flags.world ? { world: flags.world } : {}) }));
  } else if (command === 'click') {
    out(await cmd('click', { selector: rest[1] ?? '' }));
  } else if (command === 'type') {
    out(await cmd('type', { selector: rest[1] ?? '', text: rest[2] ?? '', submit: Boolean(flags.submit) }));
  } else if (command === 'select') {
    out(await cmd('select', { selector: rest[1] ?? '', value: rest[2] ?? '' }));
  } else if (command === 'scroll') {
    out(await cmd('scroll', rest[1] ? { selector: rest[1] } : { by: Number(flags.by ?? 800) }));
  } else if (command === 'highlight') {
    out(await cmd('highlight', { selector: rest[1] ?? '' }));
  } else if (command === 'shot') {
    const target = resolve(rest[1] ?? join(dirname(BRIDGE), 'var', 'shots', `shot-${Date.now()}.png`));
    const res = await cmd('shot', {});
    const base64 = String(res.dataUrl ?? '').replace(/^data:image\/\w+;base64,/, '');
    if (!base64) throw new Error('扩展没有返回截图数据');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(base64, 'base64'));
    console.log(target);
  } else if (command === 'open') {
    const url = rest[1] ?? flags.url;
    if (!url) throw new Error('用法：page.mjs open <url> [--background]');
    const res = await cmd('open', { url, active: !flags.background });
    if (flags.json) out(res);
    else console.log(`已打开 ${res.url}（tab ${res.tabId}${res.active ? '' : '，后台'}）`);
  } else if (command === 'navigate') {
    out(await cmd('navigate', { url: rest[1] ?? '' }));
  } else if (command === 'activate') {
    out(await cmd('activate', { tabId: Number(rest[1]) }));
  } else if (command === 'close') {
    out(await cmd('close', { tabId: Number(rest[1]) }));
  } else if (command === 'wait') {
    const selector = rest[1] ?? '';
    const timeout = Number(flags.timeout ?? 15000);
    const deadline = Date.now() + timeout;
    for (;;) {
      const res = await cmd('wait', { selector }, { timeoutMs: 10000 });
      if (res?.ok) { out(res); break; }
      if (Date.now() > deadline) { console.error(`等待超时：${selector}`); process.exitCode = 1; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(`page.mjs failed: ${error?.message ?? error}`);
  process.exitCode = 1;
}
