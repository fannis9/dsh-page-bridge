#!/usr/bin/env node
/**
 * P1 browser fixture: selector-scoped text/HTML reads, open shadow roots, and hard bounds.
 * The old implementation fails the assertions below: text ignores selector/shadow content
 * and HTML ignores selector/truncation metadata while serializing the whole document.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHROME = [
  process.env.DSH_BROWSER_EXECUTABLE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((path) => path && existsSync(path));
// 先归一化行尾再取锚点：下面的锚点含 "\n\n"，若 checkout 是 CRLF 就会失配
// （browser-e2e 首次真实运行正是挂在这里）。仓库侧另有 .gitattributes 声明源码为 LF，双保险。
const source = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8').replace(/\r\n/g, '\n');
const pageOpStart = source.indexOf('function PAGE_OP(payload) {');
const pageOpEnd = source.indexOf('\n\n/* --------------------------------------------------------- transport plumbing', pageOpStart);
if (pageOpStart < 0 || pageOpEnd < 0) throw new Error('无法从 background.js 抽取 PAGE_OP');
const PAGE_OP = new Function(`return (${source.slice(pageOpStart, pageOpEnd)})`)(); // eslint-disable-line no-new-func

const FIXTURE = `<!doctype html><html><body>
<div id="outside">外部内容，不应被 selector 读到</div>
<section id="target"><my-shell></my-shell><my-slotted><span slot="title">投影内容</span><span>未投影内容</span></my-slotted><pre id="pre">  foo&#10;    bar</pre><h2>标题甲</h2><p>段落乙</p><ul><li>条目丙</li><li>条目丁</li></ul><div class="filler">${'重复内容😀 '.repeat(900)}</div></section>
<script>
  const root = document.querySelector('my-shell').attachShadow({ mode: 'open' });
  root.innerHTML = '<article><h2>影子标题</h2><p>影子内容必须被读取</p></article>';
  const slotRoot = document.querySelector('my-slotted').attachShadow({ mode: 'open' });
  slotRoot.innerHTML = '<div><slot name="title"></slot></div>';
</script>
</body></html>`;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(FIXTURE, { waitUntil: 'load' });
  await page.waitForTimeout(100);

  const text = await page.evaluate(PAGE_OP, { kind: 'text', args: { selector: '#target', max: 20_000 } });
  check('selector text 只返回目标子树', text.text.includes('影子内容') && !text.text.includes('外部内容'), JSON.stringify(text).slice(0, 500));
  // 块级边界必须还原成换行：把整页塌成一行会让 agent 读不出标题/段落/列表结构（旧 innerText 是保留的）。
  check('块级结构保留换行（不塌成一行）', text.text.includes('\n'), JSON.stringify(text.text).slice(0, 300));
  check('标题与段落分行', /标题甲\s*\n+\s*段落乙/.test(text.text), JSON.stringify(text.text).slice(0, 300));
  check('列表项分行', /条目丙\s*\n+\s*条目丁/.test(text.text), JSON.stringify(text.text).slice(0, 300));
  check('slot 投影内容被读取且未重复 light DOM', text.text.includes('投影内容') && !text.text.includes('未投影内容'), JSON.stringify(text.text).slice(0, 500));

  const pre = await page.evaluate(PAGE_OP, { kind: 'text', args: { selector: '#pre', max: 200 } });
  check('pre 保留缩进与换行', pre.text.includes('  foo') && pre.text.includes('\n    bar'), JSON.stringify(pre.text));

  const started = Date.now();
  const html = await page.evaluate(PAGE_OP, { kind: 'html', args: { selector: '#target', max: 1024, maxNodes: 5000 } });
  const elapsed = Date.now() - started;
  check('selector HTML 包含 open shadow root 内容', html.html.includes('影子内容'), html.html.slice(0, 300));
  check('HTML 不包含 selector 外的内容', !html.html.includes('外部内容'), html.html.slice(0, 300));
  check('HTML 有硬上限并报告 truncated', html.truncated === true && html.length <= 1024, JSON.stringify(html).slice(0, 500));
  check('HTML 上限按 UTF-8 字节计算', html.length === new TextEncoder().encode(html.html).byteLength && html.length <= html.maxBytes, JSON.stringify(html).slice(0, 500));
  check('有界 HTML 在 3 秒内返回', elapsed < 3000, `${elapsed}ms`);
} finally {
  await browser.close().catch(() => {});
}

console.log(`\n${failures ? `✗ ${failures} 个失败` : '✓ P1 页面读取夹具通过'}`);
process.exit(failures ? 1 : 0);
