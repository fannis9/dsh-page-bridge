#!/usr/bin/env node
/**
 * snapshot-probe.mjs — run the extension's ARIA snapshot builder against a real page.
 *
 * The builder lives inside the injected PAGE_OP function in extension/background.js,
 * delimited by `#region aria-snapshot` / `#endregion aria-snapshot`. This probe extracts
 * that block (single source of truth) and executes it in a real Chromium page, so the
 * algorithm can be iterated without loading the extension.
 *
 *   node dev/snapshot-probe.mjs                    # built-in fixture
 *   node dev/snapshot-probe.mjs --url https://example.com
 *   node dev/snapshot-probe.mjs --url ... --max-nodes 800 --refs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
const require = createRequire(pathToFileURL(`${PROFILE_DIR}/`).href);
const { chromium } = require('playwright-core');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : (i >= 0 ? true : fallback);
};
const url = flag('url', null);
const maxNodes = Number(flag('max-nodes', 500));
const showRefs = Boolean(flag('refs', false));
const selector = flag('selector', null);

const CHROME = [
  process.env.DSH_BROWSER_EXECUTABLE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && require('node:fs').existsSync(p));

const source = readFileSync(join(HERE, '..', 'extension', 'background.js'), 'utf8');
const region = /\/\/ #region aria-snapshot([\s\S]*?)\/\/ #endregion aria-snapshot/.exec(source);
if (!region) {
  console.error('在后端脚本里找不到 #region aria-snapshot 区块');
  process.exit(1);
}
const builder = region[1];

const FIXTURE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>快照夹具</title></head>
<body>
  <header><nav aria-label="主导航"><a href="/home">首页</a><a href="/docs">文档</a></nav></header>
  <main>
    <h1>探索未至之境</h1>
    <h2>产品</h2>
    <p>这是一段普通正文，用来检查 text 兜底。</p>
    <form>
      <label for="q">搜索</label><input id="q" placeholder="输入关键词">
      <select id="city"><option>北京</option><option selected>上海</option></select>
      <input type="checkbox" id="ok" checked><label for="ok">同意条款</label>
      <input type="radio" name="plan" id="p1"><label for="p1">标准版</label>
      <textarea id="note" aria-label="备注">已有内容</textarea>
      <button type="submit">提交</button>
      <button disabled>不可用按钮</button>
    </form>
    <ul><li>第一项</li><li>第二项</li></ul>
    <img alt="示例图" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    <div style="display:none"><button>隐藏按钮</button></div>
    <my-widget id="widget"></my-widget>
    <div style="display:contents"><button>扁平容器里的按钮</button></div>
    <div style="visibility:hidden"><button style="visibility:visible">复活按钮</button></div>
    <button style="visibility:hidden">不可见的按钮</button>
    <details id="fold"><summary>展开看解析</summary><p>折叠里的文字不该出现</p></details>
  </main>
  <footer>© 2026 测试页脚</footer>
  <script>
    // Shadow DOM 夹具：现代 UI（GitHub 的对话框等）把控件放在 shadow root 里，
    // 普通 querySelectorAll / el.children 都看不到，必须穿透。
    const root = document.getElementById('widget').attachShadow({ mode: 'open' });
    root.innerHTML = '<section><h3>影子标题</h3><button>影子按钮</button>'
      + '<input placeholder="影子输入框"></section>';
  </script>
</body></html>`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  if (url) await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  else await page.setContent(FIXTURE, { waitUntil: 'load' });
  await page.waitForTimeout(400);

  const result = await page.evaluate(`(() => {
    ${builder}
    const wanted = ${JSON.stringify(selector)};
    // deepQuery 来自抽出的同一段代码：选择器也要能穿透 shadow DOM
    const root = wanted ? deepQuery(wanted) : null;
    if (wanted && !root) return { error: '找不到元素：' + wanted };
    return buildAriaSnapshot({ maxNodes: ${maxNodes}, root });
  })()`);
  if (result?.error) {
    console.error(result.error);
    process.exit(1);
  }

  console.log('=== ARIA 快照 ===');
  console.log(result.yaml);
  console.log('=== 统计 ===');
  console.log(JSON.stringify({ title: result.title, url: result.url, nodes: result.nodes, refs: result.refs, truncated: result.truncated }, null, 2));

  // 两类"隐形容器"自检：shadow root（穿透）与 display:contents（自身 0×0 但子树可见）
  if (!selector) {
    const hidden = await page.evaluate(`(() => {
      ${builder}
      const yaml = ${JSON.stringify(result.yaml)};
      const flat = document.querySelector('div[style*="contents"]');
      const rect = flat ? flat.getBoundingClientRect() : null;
      return {
        shadowInYaml: yaml.includes('影子按钮'),
        flatInYaml: yaml.includes('扁平容器里的按钮'),
        reviveInYaml: yaml.includes('复活按钮'),
        invisibleInYaml: yaml.includes('不可见的按钮'),
        hiddenInYaml: yaml.includes('隐藏按钮'),
        foldedInYaml: yaml.includes('折叠里的文字不该出现'),
        flatRect: rect ? Math.round(rect.width) + 'x' + Math.round(rect.height) : 'n/a',
        foldDiag: (() => {
          const p = document.querySelector('#fold p');
          if (!p) return 'no #fold p';
          const st = getComputedStyle(p);
          const box = p.getBoundingClientRect();
          return 'contentVisibility=' + st.contentVisibility + ' display=' + st.display
            + ' visibility=' + st.visibility + ' rect=' + Math.round(box.width) + 'x' + Math.round(box.height);
        })(),
        deepShadow: deepQueryAll('button').filter((el) => (el.innerText || '').includes('影子按钮')).length,
        plainQsa: document.querySelectorAll('button').length,
      };
    })()`);
    console.log('=== 隐形容器自检 ===');
    console.log(`  shadow root 里的按钮进快照     : ${hidden.shadowInYaml ? '✅' : '❌'}`);
    console.log(`  display:contents 里的按钮进快照: ${hidden.flatInYaml ? '✅' : '❌'}（该容器自身 rect = ${hidden.flatRect}）`);
    console.log(`  visibility:hidden 里被后代翻盘的按钮: ${hidden.reviveInYaml ? '✅' : '❌'}`);
    console.log(`  自身不可见的按钮不该拿到 ref      : ${hidden.invisibleInYaml ? '❌ 混进来了（可能点到看不见的元素）' : '✅ 正确屏蔽'}`);
    console.log(`  display:none 里的按钮仍应被排除    : ${hidden.hiddenInYaml ? '❌ 混进来了' : '✅ 正确排除'}`);
    console.log(`  折叠的 <details> 内容不该被读到    : ${hidden.foldedInYaml ? '❌ 泄漏了（保真问题）' : '✅ 正确屏蔽'}`);
    console.log(`  #fold p 的实际样式                : ${hidden.foldDiag}`);
    console.log(`  deepQueryAll 找到影子按钮       : ${hidden.deepShadow > 0 ? '✅' : '❌'}`);
    console.log(`  普通 querySelectorAll 的 button 数（少于总数即证明隔着 shadow）: ${hidden.plainQsa}`);
  }

  // 正向对照：把 <details> 展开后，内容就**应该**出现
  if (!selector) {
    const opened = await page.evaluate(`(() => {
      ${builder}
      document.getElementById('fold').open = true;
      const snap = buildAriaSnapshot({ maxNodes: 400 });
      return { inYaml: snap.yaml.includes('折叠里的文字不该出现') };
    })()`);
    const closedAgain = await page.evaluate(`(() => {
      ${builder}
      document.getElementById('fold').open = false;
      const snap = buildAriaSnapshot({ maxNodes: 400 });
      return { inYaml: snap.yaml.includes('折叠里的文字不该出现') };
    })()`);
    console.log('=== 折叠内容开关对照 ===');
    console.log(`  展开后能看到 : ${opened.inYaml ? '✅' : '❌'}`);
    console.log(`  再合上就看不到: ${closedAgain.inYaml ? '❌ 仍然泄漏' : '✅'}`);
  }

  // ref 稳定性自检：中间插入新元素后，老元素的 ref 不应整体错位
  if (!selector) {
    const stable = await page.evaluate(`(() => {
      ${builder}
      const pick = (needle) => deepQueryAll('button,a').find((el) => (el.innerText || '').includes(needle));
      buildAriaSnapshot({ maxNodes: 400 });
      const before = {
        submit: pick('提交') && pick('提交').getAttribute('data-dsh-ref'),
        shadow: pick('影子按钮') && pick('影子按钮').getAttribute('data-dsh-ref'),
        home: pick('首页') && pick('首页').getAttribute('data-dsh-ref'),
      };
      const fresh = document.createElement('button');
      fresh.textContent = '插队按钮';
      document.querySelector('main').prepend(fresh);
      const snap2 = buildAriaSnapshot({ maxNodes: 400 });
      const after = {
        submit: pick('提交') && pick('提交').getAttribute('data-dsh-ref'),
        shadow: pick('影子按钮') && pick('影子按钮').getAttribute('data-dsh-ref'),
        home: pick('首页') && pick('首页').getAttribute('data-dsh-ref'),
        fresh: fresh.getAttribute('data-dsh-ref'),
      };
      return { before, after, freshInYaml: snap2.yaml.includes('插队按钮'), freshRefAdvertised: snap2.yaml.includes('[ref=' + after.fresh + ']') };
    })()`);
    console.log('=== ref 稳定性自检（中间插入新元素） ===');
    console.log(`  插入前: ${JSON.stringify(stable.before)}`);
    console.log(`  插入后: ${JSON.stringify(stable.after)}`);
    const kept = stable.before.submit && stable.before.submit === stable.after.submit
      && stable.before.shadow === stable.after.shadow && stable.before.home === stable.after.home;
    console.log(`  老元素 ref 未漂移   : ${kept ? '✅' : '❌ 整体错位了'}`);
    console.log(`  新元素拿到新号并广告: ${stable.after.fresh && stable.freshRefAdvertised ? '✅ ' + stable.after.fresh : '❌'}`);
  }

  if (showRefs) {
    console.log('=== ref 解析自检（含 shadow 内容） ===');
    const resolved = await page.evaluate(`(() => {
      ${builder}
      return deepQueryAll('[data-dsh-ref]').map((el) => ({
        ref: el.getAttribute('data-dsh-ref'),
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        visible: el.getBoundingClientRect().width > 1,
      }));
    })()`);
    for (const r of resolved) console.log(`  ${r.ref.padEnd(5)} ${r.tag.padEnd(8)} visible=${r.visible} ${r.text}`);
    const bad = resolved.filter((r) => !r.visible);
    console.log(bad.length ? `⚠️ 有 ${bad.length} 个 ref 指向不可见元素` : '✅ 所有 ref 都指向可见元素');
  }
} finally {
  await browser.close();
}
